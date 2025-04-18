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
      if ((route === "/users" || route === "/trainees") && hasPost) return 1;
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
  // We'll determine which helpers to import dynamically
  let importHelpers = ["t", "runQueuedTests", "randomInt"];
  // Later, after generating test_lines, we'll add expect_field if needed
  // (the actual import line will be pushed after test_lines are generated)


  if (swaggerUiLink) {
    test_lines.push(`const SWAGGER_URL = "${swaggerUiLink}";`);
  }
  test_lines.push(`globalThis.BASE_URL = "${bakedBaseUrl}";`);
  test_lines.push("");
  // Add random user generation and first POST /sessions test
  test_lines.push("// Generate random user");
  test_lines.push("const username = `testuser_${randomInt(1000, 9999)}`;");
  test_lines.push("const password = `testpass_${randomInt(1000, 9999)}`;");
  test_lines.push("");
  test_lines.push("t(\"POST /sessions\", false, 400, {\"username\": username, \"password\": password});");
  test_lines.push("");

  // --- After test_lines are generated, insert the correct import statement at the top ---

  // --- Prioritize POST /users and POST /trainees, then POST /sessions, then everything else ---
  const prioritizedRoutes = ["/users", "/trainees"];
  // 1. POST /users and POST /trainees
  for (const prioritizedRoute of prioritizedRoutes) {
    const prioritizedItem = pathList.find(item => item.route === prioritizedRoute);
    let post409Present = false;
    if (prioritizedItem && prioritizedItem.methods.post) {
      const detail = prioritizedItem.methods.post;
      const statusCodes = Object.keys(detail.responses || {});
      sortStatusCodes(statusCodes)
        .filter((code) => code !== "500")
        .forEach((code) => {
          if (code === "409") post409Present = true;
          test_lines.push(
            `t("POST ${prioritizedRoute}", false, ${code}, ${JSON.stringify(detail.example || {})}${detail.callback ? ", res => { expect_field(res.body, 'message'); }" : ""});`
          );
        });
      if (!post409Present) {
        // Yellow background, black text: \x1b[43m (bg yellow), \x1b[30m (fg black), \x1b[0m (reset)
        test_lines.push('console.log("\x1b[43m\x1b[30mWARNING: No duplicate user check\x1b[0m")');
      }
    }
  }
  // 2. POST /sessions
  const sessionsItem = pathList.find(item => item.route === "/sessions");
  if (sessionsItem && sessionsItem.methods.post) {
    const detail = sessionsItem.methods.post;
    const statusCodes = Object.keys(detail.responses || {});
    sortStatusCodes(statusCodes)
      .filter((code) => code !== "500")
      .forEach((code) => {
        test_lines.push(
          `t("POST /sessions", false, ${code}, ${JSON.stringify(detail.example || {})}${detail.callback ? ", res => { expect_field(res.body, 'message'); }" : ""});`
        );
      });
  }
  // 3. All other tests except POST for prioritized routes and POST /sessions
  for (const { route, methods } of pathList) {
    for (const [method, detail] of Object.entries(methods)) {
      if ((prioritizedRoutes.includes(route) || route === "/sessions") && method.toLowerCase() === "post") continue;
      const statusCodes = Object.keys(detail.responses || {});
      sortStatusCodes(statusCodes)
        .filter((code) => code !== "500")
        .forEach((code) => {
        if (["get", "delete"].includes(method.toLowerCase())) {
          test_lines.push(`t("${method.toUpperCase()} ${route}", false, ${code});`);
        } else {
          // Try to get example request body from swaggerDoc
          let exampleBody: any = undefined;
          if (detail.requestBody && detail.requestBody.content) {
            const jsonContent = detail.requestBody.content["application/json"];
            if (jsonContent && jsonContent.examples) {
              // Use the first example value
              const firstExampleKey = Object.keys(jsonContent.examples)[0];
              if (firstExampleKey) {
                const example = jsonContent.examples[firstExampleKey];
                if (example && typeof example.value !== 'undefined') {
                  exampleBody = example.value;
                }
              }
            }
          }
          // Check for response example for this status code
          let responseExample = undefined;
          let responseSchemaFieldsWithExamples: string[] = [];
          // Handle $ref in responses
          let respObj = detail.responses && detail.responses[code];
          if (respObj && respObj["$ref"]) {
            // Resolve $ref, e.g. "#/components/responses/UnauthorizedError"
            const refPath = respObj["$ref"].replace(/^#\//, '').split('/');
            let refObj: any = swaggerDoc;
            for (const p of refPath) {
              refObj = refObj && refObj[p];
            }
            if (refObj && refObj.content && refObj.content["application/json"]) {
              const schema = refObj.content["application/json"].schema;
              if (schema && schema.properties) {
                for (const [k, v] of Object.entries(schema.properties)) {
                  if (v && typeof v === 'object' && 'example' in v) {
                    responseSchemaFieldsWithExamples.push(k);
                  }
                }
              }
            }
          } else if (respObj && respObj.content && respObj.content["application/json"]) {
            const respJson = respObj.content["application/json"];
            if (respJson.example) {
              responseExample = respJson.example;
            } else if (respJson.examples) {
              const firstRespExampleKey = Object.keys(respJson.examples)[0];
              if (firstRespExampleKey) {
                const respExampleObj = respJson.examples[firstRespExampleKey];
                if (respExampleObj && typeof respExampleObj.value !== 'undefined') {
                  responseExample = respExampleObj.value;
                }
              }
            }
          }
          if (responseSchemaFieldsWithExamples.length > 0) {
            // Generate expect_field for each field with example in schema
            test_lines.push(`t("${method.toUpperCase()} ${route}", false, ${code}, {}, res => { ${responseSchemaFieldsWithExamples.map(f => `expect_field(res.body, '${f}')`).join('; ')}; });`);
          } else if (typeof exampleBody !== 'undefined' && responseExample && typeof responseExample === 'object') {
            // Generate test with body and callback for response field assertion
            const fieldNames = Object.keys(responseExample);
            if (fieldNames.length > 0) {
              const field = fieldNames[0];
              test_lines.push(`t("${method.toUpperCase()} ${route}", false, ${code}, ${JSON.stringify(exampleBody)}, res => { expect_field(res.body, '${field}'); });`);
            } else {
              test_lines.push(`t("${method.toUpperCase()} ${route}", false, ${code}, ${JSON.stringify(exampleBody)});`);
            }
          } else if (responseExample && typeof responseExample === 'object') {
            // No request example, but response example exists
            const fieldNames = Object.keys(responseExample);
            if (fieldNames.length > 0) {
              const field = fieldNames[0];
              test_lines.push(`t("${method.toUpperCase()} ${route}", false, ${code}, {}, res => { expect_field(res.body, '${field}'); });`);
            } else {
              test_lines.push(`t("${method.toUpperCase()} ${route}", false, ${code}, {});`);
            }
          } else if (typeof exampleBody !== 'undefined') {
            test_lines.push(`t("${method.toUpperCase()} ${route}", false, ${code}, ${JSON.stringify(exampleBody)});`);
          } else {
            test_lines.push(`t("${method.toUpperCase()} ${route}", false, ${code}, {});`);
          }
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
  // Determine if expect_field is used
  const usesExpectField = test_lines.some(line => line.includes("expect_field"));
  if (usesExpectField && !importHelpers.includes("expect_field")) {
    importHelpers.push("expect_field");
  }
  // Insert the import statement as the first line
  test_lines.unshift(`import { ${importHelpers.join(", ")} } from "../src/test_helpers";`);
  const testScriptFilename = `${testDir}/${studentName}.${assignmentId}.test.ts`;
  writeFileSync(testScriptFilename, test_lines.join("\n"), "utf8");
  // Save swaggerDoc as JSON for reference
  if (swaggerDoc) {
    const swaggerJsonFilename = `${testDir}/${studentName}.${assignmentId}.json`;
    writeFileSync(swaggerJsonFilename, JSON.stringify(swaggerDoc, null, 2), "utf8");
    console.log(`Saved swaggerDoc as: ${swaggerJsonFilename}`);
  }
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
