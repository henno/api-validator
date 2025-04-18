import prompts from "prompts";
import { readdirSync } from "fs";
import { generateTestFile } from "./testfile_generator";

async function mainMenu() {
  while (true) {
    const response = await prompts({
      type: "select",
      name: "action",
      message: "What do you want to do?",
      choices: [
        { title: "Run a student's test file", value: "run-student" },
        { title: "Generate a new test file (generate.ts)", value: "generate" },
        { title: "Exit", value: "exit" }
      ]
    });
    if (!response.action || response.action === "exit") break;
    if (response.action === "run-student") {
      await runStudentTestFile();
    } else if (response.action === "generate") {
      await generateTestFile({ interactive: true });
    }
  }
}

// No longer needed: runScript

async function runStudentTestFile() {
  const testDir = "tests";
  let files: string[] = [];
  try {
    files = readdirSync(testDir)
      .filter(f => f.endsWith(".test.ts"))
      .map(f => `${testDir}/${f}`);
    files.sort();
  } catch {
    console.log("No tests/ directory found.");
    return;
  }
  if (!files.length) {
    console.log("No *.test.ts files found.");
    return;
  }
  const { file } = await prompts({
    type: "select",
    name: "file",
    message: "Select a student's test file to run:",
    choices: files.map(f => {
      // Extract student and assignment from filename
      const match = f.match(/\/([^.\/]+)\.([^.\/]+)\.test\.ts$/);
      let label = f;
      if (match) {
        label = `Student: ${match[1]}, Assignment: ${match[2]}`;
      }
      return { title: label, value: f };
    })
  });
  if (file) {
    await runScript(file);
  }
}

async function runScript(script: string, passthroughArgs = false) {
  const args = ["run", script];
  if (passthroughArgs) {
    args.push(...process.argv.slice(2));
  }
  const { spawn } = await import("child_process");
  const proc = spawn("bun", args, { stdio: "inherit" });
  await new Promise(resolve => proc.on("exit", resolve));
}

// Check for --run-test <file> argument
const runTestArgIndex = process.argv.indexOf("--run-test");
if (runTestArgIndex !== -1 && process.argv[runTestArgIndex + 1]) {
  const testFile = process.argv[runTestArgIndex + 1];
  runScript(testFile).then(() => process.exit(0));
} else {
  mainMenu();
}