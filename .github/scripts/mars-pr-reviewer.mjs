#!/usr/bin/env node

/**
 * Mars PR Auto-Reviewer
 * 
 * Automatically analyzes Pull Requests, performs security audits, checks repo-specific
 * conventions, and posts structured review feedback via GitHub CLI and the LLM gateway.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

const LLM_URL = (
  process.env.MARS_LLM_URL ||
  process.env.OPENAI_BASE_URL ||
  process.env.API_BASE ||
  ""
).replace(/\/+$/, "");

const LLM_KEY = process.env.MARS_LLM_API_KEY || process.env.OPENAI_API_KEY || "mars-bot-secret";
const MODEL = process.env.MARS_MODEL || process.env.LLM_MODEL || "gpt-4o";
const GITHUB_TOKEN = process.env.MARS_BOT_TOKEN || process.env.GITHUB_TOKEN;
const REPO_TYPE = process.env.REPO_TYPE || "unknown";
const PR_NUMBER = process.env.PR_NUMBER;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;

if (!LLM_URL) {
  // Any OpenAI-compatible endpoint works; there is no bundled default.
  throw new Error("MARS_LLM_URL (or OPENAI_BASE_URL / API_BASE) must be set");
}

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

async function callChatCompletion(messages) {
  const url = `${LLM_URL}/chat/completions`;
  const body = {
    model: MODEL,
    messages,
    temperature: 0.1,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM API call failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

async function main() {
  console.log("=========================================");
  console.log("Mars PR Auto-Reviewer Starting");
  console.log(`Repo: ${GITHUB_REPOSITORY || "local"} (Type: ${REPO_TYPE})`);
  console.log(`PR Number: ${PR_NUMBER || "unknown"}`);
  console.log(`Gateway: ${LLM_URL} (Model: ${MODEL})`);
  console.log("=========================================");

  if (!PR_NUMBER) {
    console.error("Missing PR_NUMBER. Exiting.");
    process.exit(1);
  }

  // Fetch PR Diff
  let diff = "";
  try {
    diff = run(`gh pr diff ${PR_NUMBER} --repo ${GITHUB_REPOSITORY}`);
  } catch (err) {
    console.warn("Could not get diff via gh CLI, falling back to git diff:", err.message);
    diff = run("git diff origin/main...HEAD", process.cwd(), true);
  }

  if (!diff || diff.trim().length === 0) {
    console.log("No diff found for PR. Exiting.");
    return;
  }

  // Cap diff length to prevent token overflow (first 25k characters)
  const cappedDiff = diff.length > 25000 ? diff.slice(0, 25000) + "\n\n... [Diff truncated for length]" : diff;

  let stackSpecificGuidance = "";
  if (REPO_TYPE === "mars-agent") {
    stackSpecificGuidance = `
Special rules for mars-agent:
- Code Quality: No 'any', no 'ReturnType<>', no inline dynamic imports.
- Privacy: ES private #fields must be used instead of TypeScript 'private' keywords on classes.
- Model Policy: Never hard-code model/provider policy in TS. Rules belong in KDL under packages/catalog/src/compat/rules/.
- Generated Files: models.json and rules.json must NEVER be hand-edited.
- TUI Sanitization: Output renderers must sanitize tabs (replaceTabs) and paths (shortenPath).
    `;
  } else if (REPO_TYPE === "mars-site") {
    stackSpecificGuidance = `
Special rules for mars-site:
- Design & Identity: Aligned with DESIGN.md and PRODUCT.md (do not fabricate claims, testimonials, or benchmark charts).
- Installers: Verify install and install.ps1 URLs and SHA256 integrity checks are intact.
    `;
  }

  const systemPrompt = `You are Mars Senior Staff Code Reviewer & Security Auditor.
Your objective is to provide a constructive, surgical, and actionable review of Pull Requests.

Output Format (Markdown):
### 🚀 Mars PR Review Summary
Brief overview of what the PR accomplishes and its architectural impact.

### 🛡️ Security Audit
Highlight any potential security concerns (auth, input validation, header handling, leaks). If none, state "No critical security risks identified."

### 🔍 Code Quality & Best Practices
Review code structure, conventions, error handling, and performance based on repo guidelines:
${stackSpecificGuidance}

### 💡 Suggestions & Improvements
Clear, concrete recommendations (with code snippets if applicable). If the PR is ready to merge, add "✅ Ready to merge".
`;

  const messages = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `Please review the following Pull Request #${PR_NUMBER} diff:\n\n\`\`\`diff\n${cappedDiff}\n\`\`\``,
    },
  ];

  console.log("Requesting review from the LLM gateway...");
  const reviewContent = await callChatCompletion(messages);

  console.log("\n--- Review Output ---\n");
  console.log(reviewContent.slice(0, 500) + "...\n");

  // Post review comment to GitHub PR
  const reviewFile = path.resolve(process.cwd(), ".bot-pr-review.md");
  fs.writeFileSync(reviewFile, reviewContent + "\n\n---\n*Reviewed autonomously by Mars PR Reviewer*", "utf8");

  try {
    run(`gh pr review ${PR_NUMBER} --repo ${GITHUB_REPOSITORY} --comment --body-file .bot-pr-review.md`);
    console.log(`Successfully posted auto-review to PR #${PR_NUMBER}!`);
  } catch (err) {
    console.warn("Failed to post PR review using 'gh pr review', trying issue comment fallback:", err.message);
    try {
      run(`gh issue comment ${PR_NUMBER} --repo ${GITHUB_REPOSITORY} --body-file .bot-pr-review.md`);
      console.log(`Posted review as comment to PR #${PR_NUMBER}.`);
    } catch (commentErr) {
      console.error("Failed to post comment fallback:", commentErr.message);
    }
  } finally {
    if (fs.existsSync(reviewFile)) fs.unlinkSync(reviewFile);
  }
}

main().catch((err) => {
  console.error("Fatal error in Mars PR Reviewer:", err);
  process.exit(1);
});
