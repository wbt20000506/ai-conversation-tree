(function (globalScope) {
  "use strict";

  const SITE_TYPE_CHATGPT = "chatgpt";
  const SITE_TYPE_COPILOT = "copilot";
  const SITE_TYPE_GITHUB_COPILOT = "github-copilot";
  const SITE_TYPE_DOUBAO = "doubao";
  const SITE_TYPE_GEMINI = "gemini";
  const SITE_TYPE_TONGYI = "tongyi";
  const SITE_TYPE_QIANWEN = "qianwen";
  const SITE_TYPE_UNKNOWN = "unknown";

  function detectSiteTypeFromLocation(targetLocation) {
    const hostname = String(targetLocation?.hostname || "").toLowerCase();
    const pathname = String(targetLocation?.pathname || "").toLowerCase();
    if (hostname === "chatgpt.com") {
      return SITE_TYPE_CHATGPT;
    }
    if (hostname === "copilot.microsoft.com" || hostname.endsWith(".copilot.microsoft.com")) {
      return SITE_TYPE_COPILOT;
    }
    if (hostname === "github.com" && pathname.startsWith("/copilot")) {
      return SITE_TYPE_GITHUB_COPILOT;
    }
    if (hostname === "doubao.com" || hostname.endsWith(".doubao.com")) {
      return SITE_TYPE_DOUBAO;
    }
    if (hostname === "gemini.google.com") {
      return SITE_TYPE_GEMINI;
    }
    if (hostname === "tongyi.aliyun.com") {
      return SITE_TYPE_TONGYI;
    }
    if (hostname === "www.qianwen.com" && pathname.startsWith("/chat")) {
      return SITE_TYPE_QIANWEN;
    }
    return SITE_TYPE_UNKNOWN;
  }

  function getChatKeyFromLocation(targetLocation) {
    const siteType = detectSiteTypeFromLocation(targetLocation || {});
    const pathname = String(targetLocation?.pathname || "/");
    const search = String(targetLocation?.search || "");
    const hash = String(targetLocation?.hash || "");
    const parts = pathname.split("/").filter(Boolean);

    if (siteType === SITE_TYPE_CHATGPT && parts[0] === "c" && parts[1]) {
      if (parts[1] === "new" || parts[1] === "c") {
        return "chatgpt-new";
      }
      return parts[1];
    }
    if (siteType === SITE_TYPE_CHATGPT) {
      return "chatgpt-home";
    }

    const pathKey = [pathname || "/", search, hash].join("");
    return siteType + ":" + (pathKey || "/");
  }

  function buildRelationshipAnalysisPrompt(entries, previousTree, savedTree) {
    const conversationText = (Array.isArray(entries) ? entries : []).map((entry) => {
      return [
        "问题ID: " + entry.analysisId,
        "问题标题: " + entry.title,
        "用户问题: " + entry.fullText
      ].join("\n");
    }).join("\n\n---\n\n");

    let previousTreeText = "";
    if (previousTree && Array.isArray(previousTree.relationships) && previousTree.relationships.length) {
      const treeText = previousTree.relationships.map((item) => {
        return item.questionId + " -> " + (item.parentId || "null");
      }).join("\n");
      previousTreeText = "\n\n上一次AI分析的对话树结构：\n" + treeText + "\n";
    }

    let savedTreeText = "";
    if (savedTree && Array.isArray(savedTree.relationships) && savedTree.relationships.length) {
      const savedText = buildSavedTreeReference(entries, savedTree);
      if (savedText) {
        savedTreeText = "\n\n用户保存的对话树结构（作为初始参考，可根据当前新问题语义调整）：\n" + savedText + "\n";
      }
    }

    return [
      "你是对话树结构分析器。请分析下面一组按时间顺序排列的对话。",
      "目标：判断每个用户问题属于哪个上级问题，输出父子关系。",
      "规则：",
      "1. 只在提供的问题ID之间建立父子关系。",
      "2. 如果某个问题是对上一个问题的继续追问、澄清、延伸、细化，则它的 parentId 应指向对应上级问题的 questionId。",
      "3. 如果某个问题开启了新主题，parentId 设为 null。",
      "4. 结果必须覆盖全部 questionId，且 questionId 不能指向自己。",
      "5. 只输出 JSON，不要输出解释，不要包含 markdown 代码块标记。",
      "6. 如果有用户保存的对话树结构，请将它作为初始参考，优先保持一致；但如果当前新增问题或当前语义表明关系应调整，可以修改已有父子关系。",
      "7. 对于没有出现在保存树中的新问题，必须根据当前问题语义重新判断，不要机械沿用旧结构。",
      "必须严格按照以下格式输出（version 固定为 1.0）：",
      "{\"version\":\"1.0\",\"relationships\":[{\"questionId\":\"问题ID\",\"parentId\":\"父问题ID或null\"}]}",
      "注意：parentId 为 null 时表示根节点，questionId 不能指向自己。",
      savedTreeText,
      previousTreeText,
      conversationText
    ].join("\n");
  }

  function buildSavedTreeReference(entries, savedTree) {
    const entryList = Array.isArray(entries) ? entries : [];
    const relationships = Array.isArray(savedTree?.relationships) ? savedTree.relationships : [];
    if (!entryList.length || !relationships.length) {
      return "";
    }

    const signatureToQuestionId = new Map();
    for (const entry of entryList) {
      if (entry?.signature && entry?.analysisId) {
        signatureToQuestionId.set(entry.signature, entry.analysisId);
      }
    }

    const nodeIdToSignature = new Map();
    for (const item of relationships) {
      if (item?.nodeId && item?.signature) {
        nodeIdToSignature.set(item.nodeId, item.signature);
      }
    }

    const mappedRelationships = [];
    for (const item of relationships) {
      if (!item?.signature) {
        continue;
      }

      const questionId = signatureToQuestionId.get(item.signature);
      if (!questionId) {
        continue;
      }

      let parentId = null;
      if (typeof item.parentId === "string" && item.parentId) {
        const parentSignature = nodeIdToSignature.get(item.parentId);
        if (parentSignature) {
          parentId = signatureToQuestionId.get(parentSignature) || null;
        }
      }

      mappedRelationships.push(questionId + " -> " + (parentId || "null"));
    }

    return mappedRelationships.join("\n");
  }

  function parseAIRelationships(text, entries) {
    const cleaned = String(text || "")
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    const relationships = Array.isArray(parsed?.relationships) ? parsed.relationships : [];
    const validIds = new Set((Array.isArray(entries) ? entries : []).map((entry) => entry.analysisId));

    return relationships
      .filter((item) => item && typeof item.questionId === "string" && validIds.has(item.questionId))
      .map((item) => {
        const parentId = typeof item.parentId === "string" && validIds.has(item.parentId) && item.parentId !== item.questionId
          ? item.parentId
          : null;
        return {
          questionId: item.questionId,
          parentId
        };
      });
  }

  const api = {
    SITE_TYPE_CHATGPT,
    SITE_TYPE_COPILOT,
    SITE_TYPE_GITHUB_COPILOT,
    SITE_TYPE_DOUBAO,
    SITE_TYPE_GEMINI,
    SITE_TYPE_TONGYI,
    SITE_TYPE_QIANWEN,
    SITE_TYPE_UNKNOWN,
    buildRelationshipAnalysisPrompt,
    detectSiteTypeFromLocation,
    getChatKeyFromLocation,
    parseAIRelationships
  };

  globalScope.CGPTTreeContentCore = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
