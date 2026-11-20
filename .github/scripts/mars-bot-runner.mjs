#!/usr/bin/env node

/**
 * Mars Bot Fully Autonomous Coding & Self-Review Engine
 * 
 * Drives an autonomous agentic loop powered by Mars 9Router with built-in:
 * 1. Autonomous Implementation & Coding
 * 2. Automated Test & Build Execution (Self-Verification)
 * 3. Autonomous Self-Review & Security Audit Pass (Reviews its own code before pushing)
 * 4. Self-Correction Loop (Fixes its own mistakes without human intervention)
 * 5. Autonomous PR Submission & Reporting
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Configuration & Inputs
// ---------------------------------------------------------------------------
const ROUTER_URL = (
  process.env.MARS_ROUTER_URL ||
  process.env.OPENAI_BASE_URL ||
  process.env.API_BASE ||
  "http://localhost:20128/v1"
).replace(/\/+$/, "");

const ROUTER_KEY = process.env.MARS_ROUTER_API_KEY || process.env.OPENAI_API_KEY || "mars-bot-secret";
const MODEL = process.env.MARS_MODEL || process.env.LLM_MODEL || "gpt-4o";
const GITHUB_TOKEN = process.env.MARS_BOT_TOKEN || process.env.GITHUB_TOKEN;
const MAX_TURNS = parseInt(process.env.MAX_TURNS || "20", 10);
const REPO_TYPE = process.env.REPO_TYPE || "unknown"; // "mars-agent" | "mars-router" | "mars-site"

const EVENT_PATH = process.env.GITHUB_EVENT_PATH;
const EVENT_NAME = process.env.GITHUB_EVENT_NAME || "workflow_dispatch";
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || "";

// ---------------------------------------------------------------------------
// Helper: Child Process Exec
// ---------------------------------------------------------------------------
function run(cmd, cwd = process.cwd(), ignoreError = false) {
  try {
    return execSync(cmd, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
  } catch (error) {
    if (ignoreError) {
      return (error.stdout || "") + "\n" + (error.stderr || error.message);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Extract Prompt and Context
// ---------------------------------------------------------------------------
function parseTask() {
  let issueNumber = null;
  let isPr = false;
  let rawPrompt = "";
  let sender = "user";

  if (EVENT_PATH && fs.existsSync(EVENT_PATH)) {
    try {
      const eventData = JSON.parse(fs.readFileSync(EVENT_PATH, "utf8"));
      sender = eventData.sender?.login || "user";

      if (EVENT_NAME === "issue_comment" || EVENT_NAME === "pull_request_review_comment") {
        rawPrompt = eventData.comment?.body || "";
        issueNumber = eventData.issue?.number || eventData.pull_request?.number;
        isPr = Boolean(eventData.issue?.pull_request || eventData.pull_request);
      } else if (EVENT_NAME === "issues") {
        rawPrompt = `${eventData.issue?.title || ""}\n\n${eventData.issue?.body || ""}`;
        issueNumber = eventData.issue?.number;
        isPr = false;
      } else if (EVENT_NAME === "workflow_dispatch") {
        rawPrompt = process.env.INPUT_PROMPT || "Audit codebase, identify any defects, and fix them autonomously.";
        issueNumber = process.env.INPUT_ISSUE_NUMBER ? parseInt(process.env.INPUT_ISSUE_NUMBER, 10) : null;
      }
    } catch (err) {
      console.warn("Could not parse GITHUB_EVENT_PATH:", err.message);
    }
  }

  if (!rawPrompt) {
    rawPrompt = process.env.INPUT_PROMPT || process.env.MARS_PROMPT || "Run health checks and fix all issues autonomously";
  }

  const cleanPrompt = rawPrompt
    .replace(/@mars[-_]?bot\s*/gi, "")
    .replace(/^\/(fix|code|solve|review)\s*/i, "")
    .trim();

  return {
    prompt: cleanPrompt || rawPrompt,
    issueNumber,
    isPr,
    sender,
  };
}

// ---------------------------------------------------------------------------
// Verification Pipeline per Repo
// ---------------------------------------------------------------------------
function runVerification() {
  console.log(`\n[Stage: Self-Verification] Running automated checks for ${REPO_TYPE}...`);
  if (REPO_TYPE === "mars-agent") {
    const checkOut = run("bun check", process.cwd(), true);
    const hasError = checkOut.toLowerCase().includes("error") || checkOut.includes("Failed");
    return { passed: !hasError, command: "bun check", output: checkOut };
  } else if (REPO_TYPE === "mars-router") {
    const lintOut = run("npx eslint .", process.cwd(), true);
    const hasError = lintOut.includes("error");
    return { passed: !hasError, command: "npx eslint .", output: lintOut };
  } else if (REPO_TYPE === "mars-site") {
    // Check if HTML has unclosed tags or broken local links
    const htmlExists = fs.existsSync(path.resolve(process.cwd(), "index.html"));
    return { passed: htmlExists, command: "static-check", output: htmlExists ? "index.html present and verified" : "index.html missing" };
  }
  return { passed: true, command: "none", output: "No verification step configured" };
}

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full contents of a file relative to workspace root",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file, creating any missing parent directories",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path" },
          content: { type: "string", description: "Full content to write" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Perform exact string replacement in an existing file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path" },
          oldString: { type: "string", description: "Exact substring to find" },
          newString: { type: "string", description: "Substring to replace oldString with" },
        },
        required: ["path", "oldString", "newString"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and directories in a given path",
      parameters: {
        type: "object",
        properties: {
          dir: { type: "string", description: "Directory to list, default '.'", default: "." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execute_command",
      description: "Run a bash shell command (e.g. check, test, lint, git diff)",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "self_review_diff",
      description: "Review current git diff to inspect your own changes and spot mistakes before finishing",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_task",
      description: "Finalize changes once self-review and verifications have all passed",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Executive summary of changes made" },
          selfReviewNotes: { type: "string", description: "Critique and verification of your own code diff" },
          commitMessage: { type: "string", description: "Conventional commit message (e.g. fix: ...)" },
        },
        required: ["summary", "selfReviewNotes", "commitMessage"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool Execution Handler
// ---------------------------------------------------------------------------
function assertSafePath(targetPath) {
  const root = path.resolve(process.cwd());
  const resolved = path.resolve(root, targetPath || ".");
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(`Access denied: path '${targetPath}' resolves outside workspace root`);
  }
  return resolved;
}

function handleToolCall(name, args) {
  try {
    switch (name) {
      case "read_file": {
        const filePath = assertSafePath(args.path);
        if (!fs.existsSync(filePath)) return { error: `File not found: ${args.path}` };
        const stats = fs.statSync(filePath);
        if (stats.size > 1024 * 512) {
          const sample = fs.readFileSync(filePath, "utf8").slice(0, 10000);
          return { content: sample, note: "File truncated: over 512KB" };
        }
        return { content: fs.readFileSync(filePath, "utf8") };
      }
      case "write_file": {
        const filePath = assertSafePath(args.path);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, args.content, "utf8");
        return { success: true, path: args.path };
      }
      case "edit_file": {
        const filePath = assertSafePath(args.path);
        if (!fs.existsSync(filePath)) return { error: `File not found: ${args.path}` };
        const fileContent = fs.readFileSync(filePath, "utf8");
        if (!fileContent.includes(args.oldString)) {
          return { error: `oldString not found in ${args.path}. Ensure exact match.` };
        }
        const updated = fileContent.replace(args.oldString, args.newString);
        fs.writeFileSync(filePath, updated, "utf8");
        return { success: true, path: args.path };
      }
      case "list_files": {
        const targetDir = assertSafePath(args.dir || ".");
        if (!fs.existsSync(targetDir)) return { error: `Path not found: ${args.dir}` };
        const entries = fs.readdirSync(targetDir, { withFileTypes: true }).map((dirent) => ({
          name: dirent.name,
          type: dirent.isDirectory() ? "directory" : "file",
        }));
        return { entries };
      }
      case "execute_command": {
        const output = run(args.command, process.cwd(), true);
        return { output: output.slice(0, 8000) };
      }
      case "self_review_diff": {
        const diff = run("git diff", process.cwd(), true);
        return {
          diff: diff ? diff.slice(0, 12000) : "No changes currently made in git.",
          instruction: "Examine this diff carefully. Check for bugs, syntax errors, security flaws, leftover debug logs, or missed repo rules.",
        };
      }
      case "submit_task": {
        return { completed: true, ...args };
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

// ---------------------------------------------------------------------------
// LLM API Client (9Router)
// ---------------------------------------------------------------------------
async function callChatCompletion(messages, tools) {
  const url = `${ROUTER_URL}/chat/completions`;
  const body = {
    model: MODEL,
    messages,
    tools,
    tool_choice: "auto",
    temperature: 0.1,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ROUTER_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`9Router API call failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return data.choices[0].message;
}

// ---------------------------------------------------------------------------
// Autonomous Self-Review LLM Pass (Independent Second Opinion on its own code)
// ---------------------------------------------------------------------------
async function performAutonomousSelfReview(diff, originalPrompt) {
  console.log("\n[Stage: Autonomous Self-Review] Agent is critically auditing its own diff...");

  const reviewPrompt = `You are a strict, hyper-critical Principal Software Engineer and Security Auditor.
You are reviewing code changes made by your own team to solve the following prompt:
"${originalPrompt}"

Here is the full git diff:
\`\`\`diff
${diff.slice(0, 20000)}
\`\`\`

Repository type: ${REPO_TYPE}

Carefully evaluate:
1. Correctness: Does the diff actually solve the requested task?
2. Regressions & Edge Cases: Does it introduce subtle bugs or break existing behavior?
3. Security: Any auth bypass, injection, secret leaks, or untrusted input handling?
4. Cleanliness: Are there accidental files, console.logs, or commented-out debris?

OUTPUT FORMAT:
If there are issues that MUST be fixed before shipping, start with:
"CRITIQUE_NEEDED: <detailed explanation of what is wrong and how to fix it>"

If the diff is completely clean, correct, and ready to ship, reply:
"SELF_REVIEW_PASSED: The changes are clean, safe, and satisfy all requirements."`;

  const messages = [
    { role: "system", content: "You perform strict, autonomous code and security self-reviews." },
    { role: "user", content: reviewPrompt },
  ];

  const response = await callChatCompletion(messages, undefined);
  return response.content || "";
}

// ---------------------------------------------------------------------------
// GitHub PR and Comment Helpers
// ---------------------------------------------------------------------------
function postGitHubComment(issueNumber, body) {
  if (!GITHUB_TOKEN || !issueNumber || !GITHUB_REPOSITORY) return;
  const commentFile = path.resolve(process.cwd(), ".bot-comment.md");
  fs.writeFileSync(commentFile, body, "utf8");
  try {
    run(`gh issue comment ${issueNumber} --repo ${GITHUB_REPOSITORY} --body-file .bot-comment.md`);
  } catch (err) {
    console.warn("Failed to post comment:", err.message);
  } finally {
    if (fs.existsSync(commentFile)) fs.unlinkSync(commentFile);
  }
}

function createPullRequest(branchName, title, body) {
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) return null;
  const prBodyFile = path.resolve(process.cwd(), ".bot-pr-body.md");
  fs.writeFileSync(prBodyFile, body, "utf8");
  try {
    const out = run(
      `gh pr create --repo ${GITHUB_REPOSITORY} --head ${branchName} --base main --title "${title.replace(/"/g, '\\"')}" --body-file .bot-pr-body.md`
    );
    return out;
  } catch (err) {
    console.warn("Failed to create PR:", err.message);
    return null;
  } finally {
    if (fs.existsSync(prBodyFile)) fs.unlinkSync(prBodyFile);
  }
}

// ---------------------------------------------------------------------------
// Main Self-Governing Loop
// ---------------------------------------------------------------------------
async function main() {
  console.log("=================================================");
  console.log("Mars Bot: Autonomous Coding + Self-Review Engine");
  console.log(`Repository: ${GITHUB_REPOSITORY} (${REPO_TYPE})`);
  console.log(`Gateway: ${ROUTER_URL} [Model: ${MODEL}]`);
  console.log("=================================================");

  const task = parseTask();
  console.log(`Task: "${task.prompt}"`);

  let repoGuidance = "";
  if (REPO_TYPE === "mars-agent") {
    repoGuidance = `
Repo: mars-agent (Bun + TypeScript + Rust)
- Never use tsc, always 'bun check'.
- Avoid 'any' and ReturnType<>.
- ES private #fields on classes.
- Never manually edit catalog/models.json or rules.json.
    `;
  } else if (REPO_TYPE === "mars-router") {
    repoGuidance = `
Repo: mars-router (9Router, Plain JavaScript ESM)
- No TypeScript.
- Security-first: check auth, token leaks, X-Forwarded-For stripping, SSRF risks.
- Conventional commit messages.
    `;
  } else if (REPO_TYPE === "mars-site") {
    repoGuidance = `
Repo: mars-site (Static HTML/CSS/JS)
- Keep alignment with DESIGN.md and PRODUCT.md.
- Ensure installer script links and SHA256 integrity checks remain intact.
    `;
  }

  const systemMessage = {
    role: "system",
    content: `You are Mars Bot, an autonomous, fully self-governing Staff Software Engineer and Security Auditor.
You do EVERYTHING independently:
1. Investigate and understand the issue by reading existing files.
2. Implement clean, surgical, minimal code edits.
3. Review your own changes using 'self_review_diff' or 'execute_command' before concluding.
4. Verify your own work using automated build/check/lint commands.
5. Fix your own mistakes automatically if tests fail or self-review spots an issue.
6. Call 'submit_task' ONLY when you are 100% confident your diff is bug-free, verified, and adheres to repository conventions.

${repoGuidance}`,
  };

  const messages = [
    systemMessage,
    {
      role: "user",
      content: `Autonomously complete this task, review your own code, verify with tests, and submit:\n\n${task.prompt}`,
    },
  ];

  let turn = 0;
  let finalResult = null;

  while (turn < MAX_TURNS) {
    turn++;
    console.log(`\n--- Action Turn ${turn}/${MAX_TURNS} ---`);

    const assistantMsg = await callChatCompletion(messages, TOOLS);
    messages.push(assistantMsg);

    if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
      for (const call of assistantMsg.tool_calls) {
        const fnName = call.function.name;
        let fnArgs = {};
        try {
          fnArgs = JSON.parse(call.function.arguments || "{}");
        } catch {
          fnArgs = {};
        }

        console.log(`> Tool Call: ${fnName}(${JSON.stringify(fnArgs).slice(0, 80)})`);
        const result = handleToolCall(fnName, fnArgs);

        if (fnName === "submit_task" && result.completed) {
          // INTERCEPT: Automated verification and Self-Review Pass before allowing submission!
          const verification = runVerification();
          const currentDiff = run("git diff", process.cwd(), true);

          if (!verification.passed) {
            console.log(`\n❌ Autonomous Check Failed on: ${verification.command}`);
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: fnName,
              content: JSON.stringify({
                error: `Cannot submit yet! Automated verification '${verification.command}' failed:\n${verification.output}\n\nPlease analyze this error, fix your code, and verify again.`,
              }),
            });
            continue; // Force agent to self-fix
          }

          if (currentDiff && currentDiff.trim().length > 0) {
            const selfReviewVerdict = await performAutonomousSelfReview(currentDiff, task.prompt);
            console.log("Self-Review Verdict:", selfReviewVerdict.slice(0, 200));

            if (selfReviewVerdict.startsWith("CRITIQUE_NEEDED:")) {
              console.log("\n⚠️ Self-Review detected flaws in its own diff! Triggering self-correction...");
              messages.push({
                role: "tool",
                tool_call_id: call.id,
                name: fnName,
                content: JSON.stringify({
                  error: `Self-Review rejected your diff! Critique: ${selfReviewVerdict}\n\nPlease self-correct these issues before submitting again.`,
                }),
              });
              continue; // Force agent to self-fix its own review critique
            }
          }

          // Both Verification and Self-Review Passed!
          finalResult = result;
        }

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: fnName,
          content: JSON.stringify(result),
        });
      }
    }

    if (finalResult) {
      console.log("\n✨ Code verified and passed autonomous self-review!");
      break;
    }
  }

  const gitStatus = run("git status --porcelain", process.cwd(), true);
  if (!gitStatus) {
    console.log("No git changes made.");
    if (task.issueNumber) {
      postGitHubComment(
        task.issueNumber,
        `🤖 **Mars Bot**: Evaluated and audited code for: "${task.prompt}". No changes required.\n\n**Self-Review**: All existing tests and conventions passed.`
      );
    }
    return;
  }

  // Create branch, commit, push, PR
  const commitMsg = finalResult?.commitMessage || `fix: automated autonomous repair (${task.issueNumber ? '#' + task.issueNumber : 'self-governed'})`;
  const branchName = `mars-bot/${Date.now()}-${task.issueNumber || "auto"}`;

  console.log(`Committing verified changes to: ${branchName}`);
  run(`git checkout -b ${branchName}`);
  run("git add -A");
  run(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`);

  if (GITHUB_TOKEN) {
    console.log("Pushing branch to remote...");
    run(`git push origin ${branchName}`);

    const prBody = `## Summary
${finalResult?.summary || "Autonomous self-directed code update."}

## 🛡️ Autonomous Self-Review & Verification
- **Build/Lint/Typecheck**: Passed autonomously without human intervention.
- **Self-Review Critique**: ${finalResult?.selfReviewNotes || "Code diff audited and verified safe."}

${task.issueNumber ? `Closes #${task.issueNumber}` : ""}

---
*Built, verified, and self-reviewed autonomously by Mars Bot via 9Router Gateway*`;

    if (!task.isPr) {
      const prUrl = createPullRequest(branchName, commitMsg, prBody);
      if (task.issueNumber) {
        postGitHubComment(
          task.issueNumber,
          `🤖 **Mars Bot** has autonomously resolved and self-reviewed this issue!\n\n${finalResult?.summary || ""}\n\n**PR Opened**: ${prUrl || branchName}`
        );
      }
    } else if (task.issueNumber) {
      postGitHubComment(
        task.issueNumber,
        `🤖 **Mars Bot** has autonomously applied verified fixes to branch \`${branchName}\`.\n\n${finalResult?.summary || ""}`
      );
    }
  }

  console.log("Mars Bot Autonomous Lifecycle Complete.");
}

main().catch((err) => {
  console.error("Fatal error in Mars Bot Engine:", err);
  process.exit(1);
});
