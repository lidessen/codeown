import { execa } from "execa";
import { promises as fs } from "fs";
import path from "path";
import { ConfigManager } from "./config";

interface FileContributors {
  [email: string]: number;
}

interface FileStats {
  [filepath: string]: FileContributors;
}

interface OwnerStats {
  [username: string]: number;
}

interface ProcessingCallback {
  (currentFile: string, processed: number, total: number): void;
}

interface AnalysisResult {
  filepath: string;
  commits: number;
  contributors: string[];
}

export class CodeOwnersGenerator {
  private repoPath: string;
  private sinceDate: string;
  private minCommits: number;
  private emailToUsername: Map<string, string>;
  private fileStats: FileStats;
  private projectInfo: { name: string; branch: string } | null = null;
  private abortSignal?: AbortSignal;
  private configManager: ConfigManager;

  constructor(options: {
    repoPath?: string;
    sinceDays?: number;
    minCommits?: number;
    abortSignal?: AbortSignal;
    configPath?: string;
  } = {}) {
    this.repoPath = options.repoPath || process.cwd();
    this.minCommits = options.minCommits || 1;

    const sinceDays = options.sinceDays || 365;
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - sinceDays);
    this.sinceDate = sinceDate.toISOString().split("T")[0];

    this.emailToUsername = new Map();
    this.fileStats = {};
    this.abortSignal = options.abortSignal;
    this.configManager = new ConfigManager();
  }

  async loadConfig(configPath?: string): Promise<void> {
    await this.configManager.loadConfig(configPath);
  }

  private async runGitCommand(cmd: string): Promise<string> {
    try {
      const args = cmd.split(" ").filter((arg) => arg.length > 0);
      const result = await execa("git", args, {
        cwd: this.repoPath,
        stdio: "pipe",
      });
      return result.stdout.trim();
    } catch (error) {
      // Silently fail - this is normal for files without git history
      return "";
    }
  }

  async getAllFiles(): Promise<string[]> {
    const output = await this.runGitCommand("ls-files");
    if (!output) return [];

    const files = output.split("\n").filter(Boolean);

    // Filter out binary files and unwanted files
    const excludedExtensions = new Set([
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".ico",
      ".pdf",
      ".zip",
      ".tar",
      ".gz",
      ".exe",
      ".dll",
      ".so",
      ".dylib",
      ".bin",
      ".obj",
      ".o",
    ]);

    return files.filter((file) => {
      if (!file) return false;
      const ext = path.extname(file).toLowerCase();
      if (excludedExtensions.has(ext)) return false;

      // Apply config include/exclude rules
      return this.configManager.shouldIncludeFile(file);
    });
  }

  private async analyzeFileContributions(
    filepath: string,
  ): Promise<FileContributors> {
    // Build command args properly
    const args = [
      "log",
      `--since=${this.sinceDate}`,
      "--format=%ae|%an",
      "--follow",
      "--",
      filepath,
    ];

    const output = await this.runGitCommand(args.join(" "));

    if (!output) {
      // Silently skip files with no history - this is normal
      return {};
    }

    const contributors: FileContributors = {};
    const lines = output.split("\n").filter((line) => line.trim());

    for (const line of lines) {
      if (!line.includes("|")) continue;

      const [email, name] = line.split("|", 2);
      if (!email || !name) continue;

      contributors[email] = (contributors[email] || 0) + 1;

      // Store name mapping for later use
      if (!this.emailToUsername.has(email)) {
        this.emailToUsername.set(email, this.extractUsername(email, name));
      }
    }

    return contributors;
  }

  private extractUsername(email: string, _name: string): string {
    // Simply return the part before @ in the email
    return email.split("@")[0];
  }

  async analyzeRepository(
    processingCallback?: ProcessingCallback,
  ): Promise<AnalysisResult[]> {
    const files = await this.getAllFiles();
    const results: AnalysisResult[] = [];

    for (let i = 0; i < files.length; i++) {
      // Check if we should abort
      if (this.abortSignal?.aborted) {
        throw new Error("Operation aborted");
      }

      const filepath = files[i];

      // Call progress callback before processing
      if (processingCallback) {
        processingCallback(filepath, i, files.length);
      }

      const contributors = await this.analyzeFileContributions(filepath);
      if (Object.keys(contributors).length > 0) {
        this.fileStats[filepath] = contributors;

        const contributorList = Object.entries(contributors)
          .map(([email]) =>
            this.emailToUsername.get(email) || email.split("@")[0]
          );

        results.push({
          filepath,
          commits: Object.values(contributors).reduce(
            (sum, count) => sum + count,
            0,
          ),
          contributors: contributorList,
        });
      }
    }

    return results;
  }

  async generateCodeowners(outputFile = "CODEOWNERS"): Promise<number> {
    const lines: string[] = [];
    lines.push("# Auto-generated CODEOWNERS file based on git history");
    lines.push(
      `# Generated on ${new Date().toISOString().split("T")[0]} ${
        new Date().toTimeString().split(" ")[0]
      }`,
    );
    lines.push(`# Analysis period: since ${this.sinceDate}`);
    lines.push(`# Minimum commits threshold: ${this.minCommits}`);

    const config = this.configManager.getConfig();
    if (config.members) {
      lines.push(`# Members filter: ${config.members.join(", ")}`);
    }
    if (config.overrides) {
      lines.push(
        `# Override rules: ${Object.keys(config.overrides).length} patterns`,
      );
    }
    if (config.maxOwners) {
      lines.push(`# Max owners per file: ${config.maxOwners}`);
    }
    if (config.minOwners) {
      lines.push(`# Min owners per file: ${config.minOwners}`);
    }
    if (config.projectOwners) {
      lines.push(
        `# Project owners (fallback): ${config.projectOwners.join(", ")}`,
      );
    }
    lines.push("");

    // Add default owners as fallback if configured
    const projectOwners = this.configManager.getProjectOwners();
    if (projectOwners.length > 0) {
      lines.push("# Default owners for all files");
      const defaultOwnersList = projectOwners.map((owner) =>
        owner.startsWith("@") ? owner : `@${owner}`
      ).join(" ");
      lines.push(`* ${defaultOwnersList}`);
      lines.push("");
    }

    // Create array of files with their owners, maintaining file order
    const fileOwners: Array<
      { filepath: string; owners: string[]; count?: number }
    > = [];

    const maxOwners = this.configManager.getMaxOwners();
    const minOwners = this.configManager.getMinOwners();

    // First check for all files in fileStats
    for (const [filepath, contributors] of Object.entries(this.fileStats)) {
      // Check if there's an override for this file
      const overrideOwners = this.configManager.getOverrideOwners(filepath);

      if (overrideOwners) {
        // Use override owners
        fileOwners.push({ filepath, owners: overrideOwners });
        continue;
      }

      if (Object.keys(contributors).length === 0) continue;

      // Get contributors filtered by members config
      const validContributors = Object.entries(contributors)
        .filter(([email]) => {
          const username = this.emailToUsername.get(email) ||
            email.split("@")[0];
          return this.configManager.shouldIncludeContributor(email, username);
        })
        .sort(([, a], [, b]) => b - a);

      if (validContributors.length === 0) continue;

      // Get top contributors based on maxOwners config
      const owners: string[] = [];
      for (let i = 0; i < Math.min(maxOwners, validContributors.length); i++) {
        const [email, commitCount] = validContributors[i];
        if (commitCount >= this.minCommits) {
          const username = this.emailToUsername.get(email) ||
            email.split("@")[0];
          owners.push(username);
        }
      }

      // If owners are less than minOwners, supplement with defaultOwners first, then projectOwners
      if (owners.length > 0 && owners.length < minOwners) {
        const ownersSet = new Set(owners);
        
        // First try defaultOwners for this specific file
        const defaultOwners = this.configManager.getDefaultOwners(filepath);
        if (defaultOwners && defaultOwners.length > 0) {
          for (const defaultOwner of defaultOwners) {
            if (!ownersSet.has(defaultOwner)) {
              owners.push(defaultOwner);
              ownersSet.add(defaultOwner);
              if (owners.length >= minOwners) break;
            }
          }
        }
        
        // If still not enough, supplement with projectOwners
        if (owners.length < minOwners && projectOwners.length > 0) {
          for (const projectOwner of projectOwners) {
            if (!ownersSet.has(projectOwner)) {
              owners.push(projectOwner);
              if (owners.length >= minOwners) break;
            }
          }
        }
      }

      if (owners.length > 0) {
        fileOwners.push({ filepath, owners });
      }
    }

    // Also check for overrides for files not in fileStats
    if (config.overrides) {
      const allFiles = await this.getAllFiles();
      for (const filepath of allFiles) {
        if (!this.fileStats[filepath]) {
          const overrideOwners = this.configManager.getOverrideOwners(filepath);
          if (overrideOwners) {
            fileOwners.push({ filepath, owners: overrideOwners });
          }
        }
      }
    }

    // Sort by file path (directory order) instead of by owner
    fileOwners.sort((a, b) => a.filepath.localeCompare(b.filepath));

    // Calculate max filepath length for alignment
    const maxPathLength = Math.min(
      Math.max(...fileOwners.map((f) => f.filepath.length), 20),
      80, // Cap at 80 characters to avoid too wide lines
    );

    // Add files to CODEOWNERS with directory structure comments
    let currentDir = "";
    for (const { filepath, owners } of fileOwners) {
      const fileDir = filepath.includes("/")
        ? filepath.substring(0, filepath.lastIndexOf("/"))
        : "";

      // Add directory comment when entering a new directory
      if (fileDir !== currentDir) {
        if (lines.length > 5) { // Add empty line before new section (except for first section)
          lines.push("");
        }

        if (fileDir === "") {
          lines.push("# Root directory");
        } else {
          lines.push(`# ${fileDir}/`);
        }
        currentDir = fileDir;
      }

      const ownersList = owners.map((owner) =>
        owner.startsWith("@") ? owner : `@${owner}`
      ).join(" ");

      // Pad filepath for alignment
      const paddedFilepath = filepath.padEnd(maxPathLength);
      lines.push(`${paddedFilepath} ${ownersList}`);
    }

    // Write to file
    const outputPath = path.join(this.repoPath, outputFile);
    await fs.writeFile(outputPath, lines.join("\n"), "utf8");

    return fileOwners.length;
  }

  async getProjectInfo(): Promise<{ name: string; branch: string }> {
    if (this.projectInfo) return this.projectInfo;

    try {
      // Get current branch
      const branchResult = await execa("git", [
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ], { cwd: this.repoPath });
      const branch = branchResult.stdout.trim();

      // Get project name from remote URL or directory name
      let name = "unknown-project";
      try {
        const remoteResult = await execa(
          "git",
          ["remote", "get-url", "origin"],
          { cwd: this.repoPath },
        );
        const remoteUrl = remoteResult.stdout.trim();
        const match = remoteUrl.match(/\/([^/]+?)(?:\.git)?$/);
        if (match) {
          name = match[1];
        }
      } catch {
        // Fallback to directory name
        name = path.basename(this.repoPath);
      }

      this.projectInfo = { name, branch };
      return this.projectInfo;
    } catch {
      this.projectInfo = { name: "unknown-project", branch: "unknown-branch" };
      return this.projectInfo;
    }
  }

  getOwnershipStats(): {
    stats: OwnerStats;
    totalFiles: number;
    uniqueOwners: number;
  } {
    const ownerStats: OwnerStats = {};
    let totalFiles = 0;

    for (const [filepath, contributors] of Object.entries(this.fileStats)) {
      // Check for override first
      const overrideOwners = this.configManager.getOverrideOwners(filepath);

      if (overrideOwners) {
        for (const owner of overrideOwners) {
          const username = owner.startsWith("@") ? owner.slice(1) : owner;
          ownerStats[username] = (ownerStats[username] || 0) + 1;
        }
        totalFiles++;
        continue;
      }

      if (Object.keys(contributors).length === 0) continue;

      // Filter by members config
      const validContributors = Object.entries(contributors)
        .filter(([email]) => {
          const username = this.emailToUsername.get(email) ||
            email.split("@")[0];
          return this.configManager.shouldIncludeContributor(email, username);
        })
        .sort(([, a], [, b]) => b - a);

      if (validContributors.length === 0) continue;

      const [email, commitCount] = validContributors[0];

      if (commitCount >= this.minCommits) {
        const username = this.emailToUsername.get(email) || email.split("@")[0];
        ownerStats[username] = (ownerStats[username] || 0) + 1;
        totalFiles++;
      }
    }

    return {
      stats: ownerStats,
      totalFiles,
      uniqueOwners: Object.keys(ownerStats).length,
    };
  }
}
