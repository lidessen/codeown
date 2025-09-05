import { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { Badge, ProgressBar, Spinner, StatusMessage } from "@inkjs/ui";
import { CodeOwnersGenerator } from "../lib/generator";

interface AnalysisResult {
  filepath: string;
  commits: number;
  contributors: string[];
}

interface AppState {
  phase: "init" | "analyzing" | "generating" | "complete" | "error";
  totalFiles: number;
  processedFiles: number;
  currentFile: string;
  analysisResults: AnalysisResult[];
  pendingFiles: string[];
  completedFiles: string[];
  stats?: {
    stats: { [username: string]: number };
    totalFiles: number;
    uniqueOwners: number;
  };
  startTime: Date;
  totalTime?: string;
  rulesGenerated?: number;
  error?: string;
  projectInfo?: { name: string; branch: string };
}

function HeaderDisplay({
  projectInfo,
}: {
  projectInfo?: { name: string; branch: string };
}) {
  return (
    <Box borderStyle="round" borderColor="blue" padding={1}>
      <Box flexDirection="column">
        <Box gap={1}>
          <Text bold color="blue">
            CODEOWNERS Generator
          </Text>
          <Text dimColor>|</Text>
          <Text color="greenBright">
            {projectInfo
              ? `${projectInfo.name} [${projectInfo.branch}]`
              : "Loading..."}
          </Text>
        </Box>
        <Text dimColor>
          Analyzing git history to determine file ownership patterns
        </Text>
      </Box>
    </Box>
  );
}

function AnalysisProgressDisplay({
  processedFiles,
  totalFiles,
  completedFiles,
  pendingFiles,
  currentFile,
}: {
  processedFiles: number;
  totalFiles: number;
  completedFiles: string[];
  pendingFiles: string[];
  currentFile: string;
}) {
  const progress = totalFiles > 0
    ? Math.round((processedFiles / totalFiles) * 100)
    : 0;

  return (
    <Box borderStyle="round" borderColor="gray" padding={1} marginBottom={1}>
      <Box flexDirection="column" width="100%">
        <Text bold>Analysis Progress</Text>
        <Box marginTop={1} flexDirection="column">
          <Box width={50}>
            <ProgressBar value={progress} />
          </Box>
          <Text>
            {progress}% ({processedFiles}/{totalFiles} files)
          </Text>
        </Box>

        {/* Recent completed files */}
        <Box marginTop={1} flexDirection="column">
          {completedFiles.slice(-5).map((file, index) => (
            <Text key={index} color="green">
              ✓ Analyzed{" "}
              {file.length > 50 ? file.substring(0, 47) + "..." : file}
            </Text>
          ))}
        </Box>

        {/* Current processing */}
        {currentFile && (
          <Box>
            <Spinner
              label={`Processing ${
                currentFile.length > 50
                  ? currentFile.substring(0, 47) + "..."
                  : currentFile
              }`}
            />
          </Box>
        )}

        {/* Pending files preview */}
        <Box flexDirection="column">
          {pendingFiles.slice(0, 1).map((file, index) => (
            <Text key={index} dimColor>
              ○ Pending:{" "}
              {file.length > 50 ? file.substring(0, 47) + "..." : file}
            </Text>
          ))}
        </Box>
      </Box>
    </Box>
  );
}

function AnalysisSummaryDisplay({
  totalFiles,
  totalTime,
  rulesGenerated,
  stats,
}: {
  totalFiles: number;
  totalTime: string;
  rulesGenerated: number;
  stats: {
    stats: { [username: string]: number };
    totalFiles: number;
    uniqueOwners: number;
  };
}) {
  const sortedContributors = Object.entries(stats.stats).sort(
    ([, a], [, b]) => b - a,
  );
  const maxFiles = Math.max(...Object.values(stats.stats));

  return (
    <Box borderStyle="round" borderDimColor padding={1}>
      <Box gap={1} flexDirection="column" width="100%">
        <Text bold>Analysis Summary</Text>

        <Box flexDirection="column">
          <Text dimColor>Total Analysis Time: {totalTime}</Text>
          <Text dimColor>{rulesGenerated} ownership rules generated</Text>
          <Text dimColor>({totalFiles} files processed)</Text>
        </Box>

        <Text bold>Top Contributors by File Count</Text>

        <Box flexDirection="column">
          {sortedContributors
            .slice(0, 10)
            .map(([contributor, fileCount], index) => {
              const percentage = ((fileCount / stats.totalFiles) * 100).toFixed(
                0,
              );
              const barWidth = Math.round((fileCount / maxFiles) * 20);
              const bar = "█".repeat(barWidth) +
                "░".repeat(Math.max(0, 20 - barWidth));

              return (
                <Box key={contributor}>
                  <Text dimColor>{(index + 1).toString().padStart(2)}.</Text>
                  <Text dimColor>{contributor.padEnd(25)}</Text>
                  <Text color="gray">{bar}</Text>
                  <Text color="cyan">
                    {" "}
                    {fileCount.toString().padStart(3)} files (
                    {percentage.padStart(3)}%)
                  </Text>
                </Box>
              );
            })}

          {sortedContributors.length > 10 && (
            <Box>
              <Text dimColor>
                And {sortedContributors.length - 10} more contributors with{" "}
                {sortedContributors
                  .slice(10)
                  .reduce((sum, [, count]) => sum + count, 0)} files (
                {(
                  (sortedContributors
                    .slice(10)
                    .reduce((sum, [, count]) => sum + count, 0) /
                    stats.totalFiles) *
                  100
                ).toFixed(0)}
                %)
              </Text>
            </Box>
          )}
        </Box>

        <Text bold>Output</Text>
        <Text dimColor>CODEOWNERS file saved to repository root</Text>
      </Box>
    </Box>
  );
}

function FooterDisplay() {
  const { exit } = useApp();

  useInput((input) => {
    if (input === "q") {
      exit();
    }
  });

  return (
    <Box justifyContent="space-between">
      <Text dimColor>[Q] Quit</Text>
      <Text dimColor>v{__APP_VERSION__}</Text>
    </Box>
  );
}

export function CodeOwnersApp({ configPath }: { configPath?: string }) {
  const [state, setState] = useState<AppState>({
    phase: "init",
    totalFiles: 0,
    processedFiles: 0,
    currentFile: "",
    analysisResults: [],
    pendingFiles: [],
    completedFiles: [],
    startTime: new Date(),
  });

  useEffect(() => {
    const abortController = new AbortController();

    const runAnalysis = async () => {
      try {
        setState((prev) => ({ ...prev, phase: "init" }));

        const generator = new CodeOwnersGenerator({
          abortSignal: abortController.signal,
        });

        // Load configuration if provided
        await generator.loadConfig(configPath);

        // Get project info
        const projectInfo = await generator.getProjectInfo();
        setState((prev) => ({ ...prev, projectInfo }));

        // Get all files first
        const files = await generator.getAllFiles();
        setState((prev) => ({
          ...prev,
          totalFiles: files.length,
          pendingFiles: files,
          phase: "analyzing",
        }));

        // Analyze repository with detailed progress tracking
        const results = await generator.analyzeRepository(
          (currentFile, processed, total) => {
            setState((prev) => {
              const newCompleted = [...prev.completedFiles];
              const newPending = prev.pendingFiles.filter(
                (f) => f !== currentFile,
              );

              if (
                processed > prev.processedFiles &&
                prev.currentFile &&
                !newCompleted.includes(prev.currentFile)
              ) {
                newCompleted.push(prev.currentFile);
              }

              return {
                ...prev,
                currentFile,
                processedFiles: processed,
                totalFiles: total,
                completedFiles: newCompleted,
                pendingFiles: newPending,
              };
            });
          },
        );

        setState((prev) => ({
          ...prev,
          phase: "generating",
          currentFile: "Generating CODEOWNERS file...",
        }));

        // Generate CODEOWNERS file
        const rulesGenerated = await generator.generateCodeowners();

        // Get final stats
        const stats = generator.getOwnershipStats();

        const endTime = new Date();
        const totalTime = `${
          Math.floor(
            (endTime.getTime() - state.startTime.getTime()) / 1000 / 60,
          )
        }m ${
          Math.floor(
            ((endTime.getTime() - state.startTime.getTime()) / 1000) % 60,
          )
        }s`;

        setState((prev) => ({
          ...prev,
          phase: "complete",
          stats,
          analysisResults: results,
          currentFile: "",
          totalTime: totalTime,
          rulesGenerated,
        }));
      } catch (error) {
        // Don't show error if operation was aborted
        if (error instanceof Error && error.message === "Operation aborted") {
          return;
        }

        const errorMsg = error instanceof Error
          ? error.message
          : "Unknown error occurred";
        setState((prev) => ({
          ...prev,
          phase: "error",
          error: errorMsg,
        }));
      }
    };

    runAnalysis();

    return () => {
      abortController.abort();
    };
  }, []);

  return (
    <Box flexDirection="column" padding={1}>
      <HeaderDisplay projectInfo={state.projectInfo} />

      {state.phase === "init" && (
        <StatusMessage variant="info">Scanning repository...</StatusMessage>
      )}

      {state.phase === "analyzing" && (
        <AnalysisProgressDisplay
          processedFiles={state.processedFiles}
          totalFiles={state.totalFiles}
          completedFiles={state.completedFiles}
          pendingFiles={state.pendingFiles}
          currentFile={state.currentFile}
        />
      )}

      {state.phase === "generating" && (
        <Box flexDirection="row" gap={1}>
          <Spinner />
          <Text>{state.currentFile}</Text>
        </Box>
      )}

      {state.phase === "complete" && state.stats && (
        <>
          <AnalysisSummaryDisplay
            totalFiles={state.totalFiles}
            totalTime={state.totalTime || "0s"}
            rulesGenerated={state.rulesGenerated || 0}
            stats={state.stats}
          />

          <Box marginTop={1} gap={1}>
            <Badge color="green">Done</Badge>
            <Text bold color="green">
              Analysis complete.
            </Text>
          </Box>
        </>
      )}

      {state.phase === "error" && (
        <StatusMessage variant="error">❌ Error: {state.error}</StatusMessage>
      )}

      {state.phase !== "complete" && <FooterDisplay />}
    </Box>
  );
}
