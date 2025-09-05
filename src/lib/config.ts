import { promises as fs } from "fs";
import path from "path";
import { minimatch } from "minimatch";

export interface CodeownConfig {
  members?: string[];
  include?: string[];
  exclude?: string[];
  overrides?: {
    [pattern: string]: string[];
  };
  defaultOwners?: {
    [pattern: string]: string[];
  };
  maxOwners?: number;
  minOwners?: number;
  projectOwners?: string[];
}

export class ConfigManager {
  private config: CodeownConfig = {};
  private configPath?: string;

  async loadConfig(configPath?: string): Promise<CodeownConfig> {
    if (configPath) {
      this.configPath = configPath;
    } else {
      const cwd = process.cwd();
      const defaultPath = path.join(cwd, "codeown.json");
      
      try {
        await fs.access(defaultPath);
        this.configPath = defaultPath;
      } catch {
        return this.config;
      }
    }

    try {
      const content = await fs.readFile(this.configPath, "utf-8");
      this.config = JSON.parse(content);
      return this.config;
    } catch (error) {
      console.error(`Error loading config from ${this.configPath}:`, error);
      throw error;
    }
  }

  getConfig(): CodeownConfig {
    return this.config;
  }

  getMaxOwners(): number {
    return this.config.maxOwners || 3;
  }

  getMinOwners(): number {
    return this.config.minOwners || 1;
  }

  getProjectOwners(): string[] {
    return this.config.projectOwners || [];
  }

  shouldIncludeContributor(email: string, username: string): boolean {
    if (!this.config.members || this.config.members.length === 0) {
      return true;
    }
    
    return this.config.members.includes(username) || 
           this.config.members.includes(email);
  }

  shouldIncludeFile(filepath: string): boolean {
    if (this.config.include && this.config.include.length > 0) {
      const included = this.config.include.some(pattern => {
        // Normalize pattern like tsconfig: if it's a directory, match all files under it
        const normalizedPattern = pattern.endsWith('/') 
          ? `${pattern}**/*`
          : pattern.includes('*') 
            ? pattern
            : `${pattern}/**/*`;
        
        return minimatch(filepath, normalizedPattern) || minimatch(filepath, pattern);
      });
      if (!included) return false;
    }

    if (this.config.exclude && this.config.exclude.length > 0) {
      const excluded = this.config.exclude.some(pattern => {
        // Normalize pattern like tsconfig: if it's a directory, match all files under it
        const normalizedPattern = pattern.endsWith('/') 
          ? `${pattern}**/*`
          : pattern.includes('*') 
            ? pattern
            : `${pattern}/**/*`;
        
        return minimatch(filepath, normalizedPattern) || minimatch(filepath, pattern);
      });
      if (excluded) return false;
    }

    return true;
  }

  getOverrideOwners(filepath: string): string[] | null {
    if (!this.config.overrides) {
      return null;
    }

    const sortedPatterns = Object.keys(this.config.overrides)
      .sort((a, b) => {
        const aSpecificity = this.getPatternSpecificity(a);
        const bSpecificity = this.getPatternSpecificity(b);
        return bSpecificity - aSpecificity;
      });

    for (const pattern of sortedPatterns) {
      if (minimatch(filepath, pattern)) {
        return this.config.overrides[pattern];
      }
    }

    return null;
  }

  getDefaultOwners(filepath: string): string[] | null {
    if (!this.config.defaultOwners) {
      return null;
    }

    const sortedPatterns = Object.keys(this.config.defaultOwners)
      .sort((a, b) => {
        const aSpecificity = this.getPatternSpecificity(a);
        const bSpecificity = this.getPatternSpecificity(b);
        return bSpecificity - aSpecificity;
      });

    for (const pattern of sortedPatterns) {
      if (minimatch(filepath, pattern)) {
        return this.config.defaultOwners[pattern];
      }
    }

    return null;
  }

  private getPatternSpecificity(pattern: string): number {
    let score = 0;
    
    if (!pattern.includes("*") && !pattern.includes("?")) {
      score += 1000;
    }
    
    const depth = pattern.split("/").length;
    score += depth * 10;
    
    const wildcards = (pattern.match(/\*/g) || []).length;
    score -= wildcards * 5;
    
    if (pattern.includes("**")) {
      score -= 50;
    }
    
    return score;
  }
}