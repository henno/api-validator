import { writeFileSync, readFileSync, existsSync } from "fs";

import prompts from "prompts";
import axios from "axios";
import * as acorn from "acorn";
import * as acornWalk from "acorn-walk";

export async function generateTestFile(options?: {
  studentName?: string;
  assignmentId?: string;
  swaggerUiLink?: string;
  specFilePath?: string;
  interactive?: boolean;
}) {
  // If options are not provided, default to interactive mode
  let studentName = options?.studentName;
  let swaggerUiLink = options?.swaggerUiLink;
  let specFilePath = options?.specFilePath;
  let assignmentId = options?.assignmentId;
  const interactive = options?.interactive ?? true;

  const promptsToAsk = [];
  if (!studentName && interactive) {
    promptsToAsk.push({
      type: "text",
      name: "studentName",
      message: "Enter the student name:",
    });
  }
  if (!assignmentId && interactive) {
    promptsToAsk.push({
      type: "text",
      name: "assignmentId",
      message: "Enter the assignment number (e.g., 1, 2, 3):",
    });
  }
  if (!swaggerUiLink && !specFilePath && interactive) {
    promptsToAsk.push({
      type: "text",
      name: "swaggerUiLink",
      message: "Enter the Swagger UI link (e.g., https://docs.studentname.me):",
    });
  }
  if (promptsToAsk.length > 0 && interactive) {
    const answers = await prompts(promptsToAsk);
    studentName = studentName || answers.studentName;
    assignmentId = assignmentId || answers.assignmentId;
    swaggerUiLink = swaggerUiLink || answers.swaggerUiLink;
  }
  if (!studentName) {
    console.error("Student name is required.");
    return;
  }
  if (!assignmentId) {
    console.error("Assignment number is required.");
    return;
  }
  studentName = studentName.toLowerCase();
  assignmentId = assignmentId.toLowerCase();
  if (!swaggerUiLink && !specFilePath) {
    console.error("Either a Swagger UI link or an OpenAPI spec file path is required.");
    return;
  }
  let swaggerDoc: any;
  if (specFilePath) {
    try {
      if (!existsSync(specFilePath)) {
        console.error(`File not found: ${specFilePath}`);
        return;
      }
      const fileContent = readFileSync(specFilePath, "utf8");
      try {
        swaggerDoc = JSON.parse(fileContent);
      } catch (err) {
        console.error("Failed to parse the spec file as JSON:", err);
        return;
      }
    } catch (err) {
      console.error("Error reading the spec file:", err);
      return;
    }
  } else {
    // Otherwise, fetch from URL
    const initJsUrl = `${swaggerUiLink.replace(/\/+$/, "")}/swagger-ui-init.js`;
    let initJsContent: string;
    try {
      const response = await axios.get(initJsUrl);
      initJsContent = response.data;
    } catch (error) {
      console.error("Failed to download swagger-ui-init.js, trying alternative approaches");
      initJsContent = "";
    }
    try {
      const ast = acorn.parse(initJsContent, { ecmaVersion: 2020 });
      let swaggerDocNode = null;
      acornWalk.simple(ast, {
        VariableDeclarator(node: any) {
          if (node.id.name === "swaggerDoc") {
            swaggerDocNode = node.init;
          }
        },
        AssignmentExpression(node: any) {
          if (node.left.type === "Identifier" && node.left.name === "swaggerDoc") {
            swaggerDocNode = node.right;
          }
        },
        Property(node: any) {
          // Handles { ..., "swaggerDoc": { ... }, ... }
          if (
            (node.key.type === "Identifier" && node.key.name === "swaggerDoc") ||
            (node.key.type === "Literal" && node.key.value === "swaggerDoc")
          ) {
            swaggerDocNode = node.value;
          }
        }
      });
      if (!swaggerDocNode) {
        console.error("Could not find swaggerDoc in swagger-ui-init.js");
        return;
      }
      swaggerDoc = evalSwaggerDoc(swaggerDocNode);
    } catch (err) {
      console.error("Error parsing swagger-ui-init.js:", err);
      return;
    }
  }
  // Step 5: Determine API base URL
  // --- Step 5: Determine API base URL (baked into test file) ---
  let bakedBaseUrl = "";
  if (swaggerDoc?.servers && Array.isArray(swaggerDoc.servers) && swaggerDoc.servers.length > 0) {
    const firstServerUrl = swaggerDoc.servers[0].url;
    if (typeof firstServerUrl === "string" && firstServerUrl.startsWith("http")) {
      bakedBaseUrl = firstServerUrl.replace(/\/$/, "");
    } else if (typeof firstServerUrl === "string" && (firstServerUrl === "/" || firstServerUrl.startsWith("/"))) {
      // Relative or root: use protocol+host from swaggerUiLink
      try {
        const u = new URL(swaggerUiLink!);
        bakedBaseUrl = `${u.protocol}//${u.host}`;
      } catch {
        console.error("Could not parse swaggerUiLink to extract base URL");
        return;
      }
    } else {
      // Fallback: use protocol+host from swaggerUiLink
      try {
        const u = new URL(swaggerUiLink!);
        bakedBaseUrl = `${u.protocol}//${u.host}`;
      } catch {
        console.error("Could not parse swaggerUiLink to extract base URL");
        return;
      }
    }
  } else if (swaggerUiLink) {
    try {
      const u = new URL(swaggerUiLink);
      bakedBaseUrl = `${u.protocol}//${u.host}`;
    } catch {
      console.error("Could not parse swaggerUiLink to extract base URL");
      return;
    }
  } else if (interactive) {
    const { apiBaseUrl } = await prompts({
      type: "text",
      name: "apiBaseUrl",
      message: "Enter the base URL for API requests:",
    });
    if (apiBaseUrl) {
      bakedBaseUrl = apiBaseUrl;
    } else {
      console.error("API base URL is required to generate test script");
      return;
    }
  }
  // Step 6: Generate test file stubs
  const paths = swaggerDoc.paths || {};
  const pathList = Object.entries(paths).map(([route, methods]) => {
    return { route, methods: methods as Record<string, any> };
  });
  pathList.sort((a, b) => {
    const priorityFor = (item: { route: string; methods: Record<string, any> }) => {
      const route = item.route;
      const methods = Object.keys(item.methods);
      const hasPost = methods.includes("post");
      if (route === "/users" && hasPost) return 1;
      if (route === "/sessions" && hasPost) return 2;
      return 3;
    };
    return priorityFor(a) - priorityFor(b);
  });
  function sortStatusCodes(statusCodes: string[]) {
    return statusCodes.sort((a, b) => {
      const aNum = parseInt(a, 10);
      const bNum = parseInt(b, 10);
      const aIsNeg = aNum >= 400 && aNum < 600;
      const bIsNeg = bNum >= 400 && bNum < 600;
      if (aIsNeg && !bIsNeg) return -1;
      if (!aIsNeg && bIsNeg) return 1;
      return aNum - bNum;
    });
  }
  const test_lines: string[] = [];
  test_lines.push(`import { t, runQueuedTests } from "../src/test_helpers";`);

  test_lines.push(`globalThis.BASE_URL = "${bakedBaseUrl}";`);
  test_lines.push("");
  for (const { route, methods } of pathList) {
    for (const [method, detail] of Object.entries(methods)) {
      const statusCodes = Object.keys(detail.responses || {});
      const sortedCodes = sortStatusCodes(statusCodes);
      sortedCodes.forEach((code) => {
        if (["get", "delete"].includes(method.toLowerCase())) {
          test_lines.push(`t("${method.toUpperCase()} ${route}", false, ${code});`);
        } else {
          test_lines.push(`t("${method.toUpperCase()} ${route}", false, ${code}, {});`);
        }
      });
    }
  }
  test_lines.push("");
  test_lines.push("runQueuedTests();");
  const testDir = "tests";
  if (!existsSync(testDir)) {
    require("fs").mkdirSync(testDir);
  }
  const testScriptFilename = `${testDir}/${studentName}.${assignmentId}.test.ts`;
  writeFileSync(testScriptFilename, test_lines.join("\n"), "utf8");
  console.log(`Generated test script: ${testScriptFilename}`);
  console.log(`Done.`);
}

function astToObject(node: any): any {
  if (!node) return undefined;
  switch (node.type) {
    case "ObjectExpression": {
      const obj: Record<string, any> = {};
      for (const prop of node.properties) {
        let key = prop.key.type === "Identifier" ? prop.key.name : prop.key.value;
        obj[key] = astToObject(prop.value);
      }
      return obj;
    }
    case "ArrayExpression":
      return node.elements.map(astToObject);
    case "Literal":
      return node.value;
    case "Identifier":
      // Could try to resolve known identifiers if needed
      return node.name;
    default:
      return undefined;
  }
}

function evalSwaggerDoc(node: any): any {
  try {
    return astToObject(node);
  } catch (e) {
    return {};
  }
}
