import { execa } from 'execa'
import { promises as fs } from 'fs'
import path from 'path'

interface FileContributors {
  [email: string]: number
}

interface FileStats {
  [filepath: string]: FileContributors
}

interface OwnerStats {
  [username: string]: number
}

interface ProcessingCallback {
  (currentFile: string, processed: number, total: number): void
}

interface AnalysisResult {
  filepath: string
  commits: number
  contributors: string[]
}

export class CodeOwnersGenerator {
  private repoPath: string
  private sinceDate: string
  private minCommits: number
  private emailToUsername: Map<string, string>
  private fileStats: FileStats
  private projectInfo: { name: string; branch: string } | null = null

  constructor(options: {
    repoPath?: string
    sinceDays?: number
    minCommits?: number
  } = {}) {
    this.repoPath = options.repoPath || process.cwd()
    this.minCommits = options.minCommits || 1
    
    const sinceDays = options.sinceDays || 365
    const sinceDate = new Date()
    sinceDate.setDate(sinceDate.getDate() - sinceDays)
    this.sinceDate = sinceDate.toISOString().split('T')[0]
    
    this.emailToUsername = new Map()
    this.fileStats = {}
  }

  private async runGitCommand(cmd: string): Promise<string> {
    try {
      const args = cmd.split(' ').filter(arg => arg.length > 0)
      const result = await execa('git', args, {
        cwd: this.repoPath,
        stdio: 'pipe'
      })
      return result.stdout.trim()
    } catch (error) {
      // Silently fail - this is normal for files without git history
      return ''
    }
  }

  async getAllFiles(): Promise<string[]> {
    const output = await this.runGitCommand('ls-files')
    if (!output) return []

    const files = output.split('\n').filter(Boolean)
    
    // Filter out binary files and unwanted files
    const excludedExtensions = new Set([
      '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf',
      '.zip', '.tar', '.gz', '.exe', '.dll', '.so',
      '.dylib', '.bin', '.obj', '.o'
    ])

    return files.filter(file => {
      if (!file) return false
      const ext = path.extname(file).toLowerCase()
      return !excludedExtensions.has(ext)
    })
  }

  private async analyzeFileContributions(filepath: string): Promise<FileContributors> {
    // Build command args properly
    const args = [
      'log',
      `--since=${this.sinceDate}`,
      '--format=%ae|%an',
      '--follow',
      '--',
      filepath
    ]
    
    const output = await this.runGitCommand(args.join(' '))
    
    if (!output) {
      // Silently skip files with no history - this is normal
      return {}
    }

    const contributors: FileContributors = {}
    const lines = output.split('\n').filter(line => line.trim())
    
    for (const line of lines) {
      if (!line.includes('|')) continue
      
      const [email, name] = line.split('|', 2)
      if (!email || !name) continue
      
      contributors[email] = (contributors[email] || 0) + 1
      
      // Store name mapping for later use
      if (!this.emailToUsername.has(email)) {
        this.emailToUsername.set(email, this.extractUsername(email, name))
      }
    }

    return contributors
  }

  private extractUsername(email: string, _name: string): string {
    // Try to get username from email
    let username = email.split('@')[0]
    
    // Clean up username (remove dots, numbers at the end, etc.)
    username = username.replace(/[._-]\d+$/, '')
    username = username.replace(/[^\w-]/g, '')
    
    return username
  }

  async analyzeRepository(processingCallback?: ProcessingCallback): Promise<AnalysisResult[]> {
    const files = await this.getAllFiles()
    const results: AnalysisResult[] = []
    
    for (let i = 0; i < files.length; i++) {
      const filepath = files[i]
      
      // Call progress callback before processing
      if (processingCallback) {
        processingCallback(filepath, i, files.length)
      }
      
      const contributors = await this.analyzeFileContributions(filepath)
      if (Object.keys(contributors).length > 0) {
        this.fileStats[filepath] = contributors
        
        const contributorList = Object.entries(contributors)
          .map(([email]) => this.emailToUsername.get(email) || email.split('@')[0])
        
        results.push({
          filepath,
          commits: Object.values(contributors).reduce((sum, count) => sum + count, 0),
          contributors: contributorList
        })
      }
    }
    
    return results
  }

  async generateCodeowners(outputFile = 'CODEOWNERS'): Promise<number> {
    const lines: string[] = []
    lines.push('# Auto-generated CODEOWNERS file based on git history')
    lines.push(`# Generated on ${new Date().toISOString().split('T')[0]} ${new Date().toTimeString().split(' ')[0]}`)
    lines.push(`# Analysis period: since ${this.sinceDate}`)
    lines.push(`# Minimum commits threshold: ${this.minCommits}`)
    lines.push('')

    // Create array of files with their owners, maintaining file order
    const fileOwners: Array<{ filepath: string; owner: string; count: number }> = []

    for (const [filepath, contributors] of Object.entries(this.fileStats)) {
      if (Object.keys(contributors).length === 0) continue

      // Get the top contributor
      const sortedContributors = Object.entries(contributors).sort(([,a], [,b]) => b - a)
      const [email, commitCount] = sortedContributors[0]

      if (commitCount >= this.minCommits) {
        const username = this.emailToUsername.get(email) || email.split('@')[0]
        fileOwners.push({ filepath, owner: username, count: commitCount })
      }
    }

    // Sort by file path (directory order) instead of by owner
    fileOwners.sort((a, b) => a.filepath.localeCompare(b.filepath))

    // Add files to CODEOWNERS with directory structure comments
    let currentDir = ''
    for (const { filepath, owner } of fileOwners) {
      const fileDir = filepath.includes('/') ? filepath.substring(0, filepath.lastIndexOf('/')) : ''
      
      // Add directory comment when entering a new directory
      if (fileDir !== currentDir) {
        if (lines.length > 5) { // Add empty line before new section (except for first section)
          lines.push('')
        }
        
        if (fileDir === '') {
          lines.push('# Root directory')
        } else {
          lines.push(`# ${fileDir}/`)
        }
        currentDir = fileDir
      }
      
      lines.push(`${filepath} @${owner}`)
    }

    // Write to file
    const outputPath = path.join(this.repoPath, outputFile)
    await fs.writeFile(outputPath, lines.join('\n'), 'utf8')

    return fileOwners.length
  }

  async getProjectInfo(): Promise<{ name: string; branch: string }> {
    if (this.projectInfo) return this.projectInfo

    try {
      // Get current branch
      const branchResult = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: this.repoPath })
      const branch = branchResult.stdout.trim()

      // Get project name from remote URL or directory name
      let name = 'unknown-project'
      try {
        const remoteResult = await execa('git', ['remote', 'get-url', 'origin'], { cwd: this.repoPath })
        const remoteUrl = remoteResult.stdout.trim()
        const match = remoteUrl.match(/\/([^/]+?)(?:\.git)?$/)
        if (match) {
          name = match[1]
        }
      } catch {
        // Fallback to directory name
        name = path.basename(this.repoPath)
      }

      this.projectInfo = { name, branch }
      return this.projectInfo
    } catch {
      this.projectInfo = { name: 'unknown-project', branch: 'unknown-branch' }
      return this.projectInfo
    }
  }

  getOwnershipStats(): { stats: OwnerStats; totalFiles: number; uniqueOwners: number } {
    const ownerStats: OwnerStats = {}
    let totalFiles = 0

    for (const [, contributors] of Object.entries(this.fileStats)) {
      if (Object.keys(contributors).length === 0) continue

      const sortedContributors = Object.entries(contributors).sort(([,a], [,b]) => b - a)
      const [email, commitCount] = sortedContributors[0]

      if (commitCount >= this.minCommits) {
        const username = this.emailToUsername.get(email) || email.split('@')[0]
        ownerStats[username] = (ownerStats[username] || 0) + 1
        totalFiles++
      }
    }

    return {
      stats: ownerStats,
      totalFiles,
      uniqueOwners: Object.keys(ownerStats).length
    }
  }
}