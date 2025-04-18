import { writeFileSync, readFileSync, existsSync } from "fs";

import prompts from "prompts";
import axios from "axios";
import * as acorn from "acorn";
import * as acornWalk from "acorn-walk";

// --- Helper to resolve $ref in an object ---
export function resolveRef(obj: any, ref: string): any {
  if (!ref.startsWith('#/')) return undefined;
  const path = ref.slice(2).split('/');
  let cur = obj;
  for (const p of path) {
    if (cur && typeof cur === 'object') cur = cur[p];
    else return undefined;
  }
  return cur;
}

// --- Helper to extract examples from a response object ---
export function extractResponseExamples(respObj: any): any {
  if (!respObj || typeof respObj !== 'object') return undefined;

  // Check for direct examples
  if (respObj.content?.['application/json']?.examples) {
    const examples = respObj.content['application/json'].examples;
    const firstKey = Object.keys(examples)[0];
    if (firstKey && examples[firstKey]?.value) {
      return examples[firstKey].value;
    }
  }

  // Check for direct example
  if (respObj.content?.['application/json']?.example) {
    return respObj.content['application/json'].example;
  }

  return undefined;
}

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
      // Extract request-body example
      let exampleBody: any;
      const jsonContentPri = prioritizedItem.methods.post.requestBody?.content?.["application/json"];
      if (jsonContentPri) {
        if (jsonContentPri.examples) {
          const exs = jsonContentPri.examples;
          const k = Object.keys(exs)[0];
          if (k && exs[k].value !== undefined) exampleBody = exs[k].value;
        }
        if (exampleBody === undefined && jsonContentPri.example !== undefined) {
          exampleBody = jsonContentPri.example;
        }
        const schPri = jsonContentPri.schema;
        if (exampleBody === undefined && schPri) {
          const resSch = schPri.$ref ? resolveRef(swaggerDoc, schPri.$ref) : schPri;
          if (resSch.example !== undefined) exampleBody = resSch.example;
          else if (resSch.properties) {
            exampleBody = {};
            for (const [k2, v2] of Object.entries<any>(resSch.properties)) {
              if (v2.example !== undefined) exampleBody[k2] = v2.example;
            }
          }
        }
      }
      const statusCodes = Object.keys(detail.responses || {});
      sortStatusCodes(statusCodes)
        .filter((code) => code !== "500")
        .forEach((code) => {
          if (code === "409") post409Present = true;
          test_lines.push(
            `t("POST ${prioritizedRoute}", false, ${code}, ${JSON.stringify(exampleBody ?? {})}${detail.callback ? ", res => { expect_field(res.body, 'message'); }" : ""});`
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
    // Extract request-body example for sessions
    let sessBody: any;
    const jsonContentSes = detail.requestBody?.content?.["application/json"];
    if (jsonContentSes) {
      if (jsonContentSes.examples) {
        const exs2 = jsonContentSes.examples;
        const k2 = Object.keys(exs2)[0];
        if (k2 && exs2[k2].value !== undefined) sessBody = exs2[k2].value;
      }
      if (sessBody === undefined && jsonContentSes.example !== undefined) sessBody = jsonContentSes.example;
      const schSes = jsonContentSes.schema;
      if (sessBody === undefined && schSes) {
        const r2 = schSes.$ref ? resolveRef(swaggerDoc, schSes.$ref) : schSes;
        if (r2.example !== undefined) sessBody = r2.example;
        else if (r2.properties) {
          sessBody = {};
          for (const [kk, vv] of Object.entries<any>(r2.properties)) if (vv.example !== undefined) sessBody[kk] = vv.example;
        }
      }
    }
    const statusCodes2 = Object.keys(detail.responses || {});
    sortStatusCodes(statusCodes2)
      .filter((code) => code !== "500")
      .forEach((code) => {
        test_lines.push(
          `t("POST /sessions", false, ${code}, ${JSON.stringify(sessBody ?? {})}${detail.callback ? ", res => { expect_field(res.body, 'message'); }" : ""});`
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
            return;
          }
          // Try to get example request body from swaggerDoc
          let exampleBody: any;
          const jsonContent = detail.requestBody?.content?.["application/json"];
          if (jsonContent) {
            // Direct examples
            if (jsonContent.examples) {
              const examples = jsonContent.examples;
              const firstKey = Object.keys(examples)[0];
              if (firstKey) {
                const ex = examples[firstKey];
                if (ex?.value !== undefined) exampleBody = ex.value;
              }
            }
            // Single example
            if (exampleBody === undefined && jsonContent.example !== undefined) {
              exampleBody = jsonContent.example;
            }
            // Schema-based examples
            const sch = jsonContent.schema;
            if (exampleBody === undefined && sch) {
              const resolved = sch.$ref ? resolveRef(swaggerDoc, sch.$ref) : sch;
              if (resolved.example !== undefined) {
                exampleBody = resolved.example;
              } else if (resolved.properties) {
                exampleBody = {};
                for (const [k, v] of Object.entries<any>(resolved.properties)) {
                  if (v.example !== undefined) exampleBody[k] = v.example;
                }
              }
            }
          }
          // Unified response handling
          let respJson: any = detail.responses?.[code];
          let originalRespJson = respJson; // Keep the original reference for later

          // Resolve response reference if it exists
          if (respJson?.['$ref']) {
            respJson = resolveRef(swaggerDoc, respJson['$ref']) || respJson;
          }

          const contentJson = respJson?.content?.["application/json"];
          const schema = contentJson?.schema;

          // Extract fields with examples from schema properties
          const fieldsWithExamples = schema?.properties
            ? Object.entries<any>(schema.properties)
                .filter(([_, v]) => typeof v === "object" && v.example !== undefined)
                .map(([k]) => k)
            : [];

          // Try to get response example from various sources
          let responseExample: any;

          // 1. Try direct examples in the content
          if (contentJson?.example) {
            responseExample = contentJson.example;
          } else if (contentJson?.examples) {
            const key = Object.keys(contentJson.examples)[0];
            const respEx = contentJson.examples[key];
            if (respEx?.value !== undefined) responseExample = respEx.value;
          }

          // 2. If no example found and we have a schema reference, try to get examples from there
          if (responseExample === undefined && schema?.['$ref']) {
            const refSchema = resolveRef(swaggerDoc, schema['$ref']);
            if (refSchema?.example) {
              responseExample = refSchema.example;
            }
          }

          // 3. If still no example and we had a response reference, check if the referenced component has examples
          if (responseExample === undefined && originalRespJson?.['$ref']) {
            // Get the referenced response component
            const refResp = resolveRef(swaggerDoc, originalRespJson['$ref']);
            // Extract examples from it
            if (refResp) {
              const refExample = extractResponseExamples(refResp);
              if (refExample) responseExample = refExample;
            }
          }

          // Generate test lines
          if (fieldsWithExamples.length) {
            test_lines.push(`t("${method.toUpperCase()} ${route}", false, ${code}, {}, res => { expect_field(res.body, ${JSON.stringify(fieldsWithExamples)}); });`);
          } else if (responseExample && typeof responseExample === "object") {
            const fns = Object.keys(responseExample);
            if (fns.length) {
              test_lines.push(`t("${method.toUpperCase()} ${route}", false, ${code}, ${JSON.stringify(exampleBody ?? {})}, res => { expect_field(res.body, ${JSON.stringify(fns)}); });`);
            } else {
              test_lines.push(`t("${method.toUpperCase()} ${route}", false, ${code}, ${JSON.stringify(exampleBody ?? {})});`);
            }
          } else if (exampleBody !== undefined) {
            test_lines.push(`t("${method.toUpperCase()} ${route}", false, ${code}, ${JSON.stringify(exampleBody)});`);
          } else {
            // For error responses (4xx, 5xx), add validation for 'message' field
            const codeNum = parseInt(code, 10);
            if (codeNum >= 400 && codeNum < 600) {
              test_lines.push(`t("${method.toUpperCase()} ${route}", false, ${code}, {}, res => { expect_field(res.body, 'message'); });`);
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
