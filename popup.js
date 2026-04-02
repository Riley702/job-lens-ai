const analyzeBtn = document.getElementById("analyzeBtn");
const openOptionsBtn = document.getElementById("openOptionsBtn");
const fillFormBtn = document.getElementById("fillFormBtn");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const LAST_RESULT_KEY = "lastAnalysisResult";

function setStatus(text, isError = false) {
  statusEl.className = `small ${isError ? "err" : ""}`;
  statusEl.textContent = text;
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function tokenizeLatin(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((x) => x.length >= 2);
}

function cjkBigrams(text) {
  const chars = (text || "").match(/[\u4e00-\u9fff]/g) || [];
  const grams = [];
  for (let i = 0; i < chars.length - 1; i += 1) grams.push(chars[i] + chars[i + 1]);
  return grams;
}

function scoreChunk(query, chunk) {
  const qLatin = tokenizeLatin(query);
  const qCjk = cjkBigrams(query);
  const cText = (chunk || "").toLowerCase();

  let score = 0;
  for (const t of qLatin) {
    if (cText.includes(t)) score += 1;
  }
  for (const g of qCjk) {
    if ((chunk || "").includes(g)) score += 0.6;
  }
  return score;
}

function retrieveResumeChunks(jobText, resumeChunks, topK) {
  const scored = (resumeChunks || [])
    .map((chunk) => ({ chunk, score: scoreChunk(jobText, chunk) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK || 4)
    .filter((x) => x.score > 0);

  if (!scored.length) {
    return (resumeChunks || []).slice(0, Math.min(topK || 4, 4));
  }
  return scored.map((x) => x.chunk);
}

async function getCurrentPageText() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("无法获取当前标签页");

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const title = document.title || "";
      const bodyText = (document.body?.innerText || "").slice(0, 30000);
      const url = location.href;
      return { title, bodyText, url };
    }
  });

  return result;
}

function parseFormProfile(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    if (!Array.isArray(parsed?.profileRules)) return { profileRules: [] };
    return {
      profileRules: parsed.profileRules
        .map((r) => ({
          keywords: Array.isArray(r?.keywords) ? r.keywords.map((k) => String(k || "").toLowerCase().trim()).filter(Boolean) : [],
          answer: String(r?.answer || "").trim()
        }))
        .filter((r) => r.keywords.length && r.answer)
    };
  } catch {
    return { profileRules: [] };
  }
}

async function checkAndFillApplicationForm(formProfile) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("无法获取当前标签页");

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [formProfile],
    func: (formProfileArg) => {
      const normalize = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
      const profileRules = Array.isArray(formProfileArg?.profileRules) ? formProfileArg.profileRules : [];

      const builtinRules = [
        { key: "non_compete", patterns: [/non[- ]?compete/, /竞业/, /竞业限制/], desired: "no" },
        { key: "crime_history", patterns: [/crime/, /criminal/, /felony/, /convict/, /offen[cs]e/, /犯罪/, /刑事/], desired: "no" },
        { key: "visa_sponsorship_need", patterns: [/require sponsorship/, /need sponsorship/, /future.*sponsorship/, /work authorization.*sponsorship/, /需要.*sponsor/, /需要.*签证/], desired: "yes" },
        { key: "authorized_to_work", patterns: [/legally authorized to work/, /authorized to work/, /work authorization/, /有合法.*工作/, /合法.*工作许可/], desired: "yes" }
      ];

      const detectRule = (questionText) => {
        const q = normalize(questionText);
        const custom = profileRules.find((r) => (r.keywords || []).every((k) => q.includes(normalize(k))));
        if (custom) return { key: "custom", desired: custom.answer, customAnswer: custom.answer };
        for (const r of builtinRules) {
          if (r.patterns.some((p) => p.test(q))) return r;
        }
        return null;
      };

      const getQuestionText = (el) => {
        const ids = [el.id, el.getAttribute("name")].filter(Boolean);
        for (const id of ids) {
          const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (label?.innerText?.trim()) return label.innerText.trim();
        }
        const wrapLabel = el.closest("label");
        if (wrapLabel?.innerText?.trim()) return wrapLabel.innerText.trim();
        const block = el.closest("fieldset, .form-group, .question, .application-question, [role='group']") || el.parentElement;
        return (block?.innerText || "").slice(0, 300).trim();
      };

      const pickOptionByDesired = (desired, text) => {
        const d = normalize(desired);
        const t = normalize(text);
        if (["yes", "是"].includes(d)) return /\byes?\b|是/.test(t);
        if (["no", "否"].includes(d)) return /\bno\b|否/.test(t);
        return t.includes(d);
      };

      const radioGroups = new Map();
      for (const input of Array.from(document.querySelectorAll('input[type="radio"]'))) {
        const name = input.name || `__anon_${Math.random()}`;
        if (!radioGroups.has(name)) radioGroups.set(name, []);
        radioGroups.get(name).push(input);
      }

      const touched = [];
      const allQuestions = [];

      for (const radios of radioGroups.values()) {
        const question = getQuestionText(radios[0]);
        const rule = detectRule(question);
        const options = radios.map((r) => ((r.closest("label")?.innerText || r.value || "").trim()));
        const selectedRadio = radios.find((r) => r.checked);
        const selectedText = selectedRadio ? ((selectedRadio.closest("label")?.innerText || selectedRadio.value || "").trim()) : "";

        allQuestions.push({ type: "radio", question, options, selected: selectedText || "(blank)", matchedRule: rule?.key || "" });
        if (!rule) continue;

        if (selectedRadio) {
          touched.push({ question, action: "kept", reason: "already answered", rule: rule.key, options, selected: selectedText || "(blank)" });
          continue;
        }

        const desired = rule.customAnswer || rule.desired;
        const target = radios.find((r) => pickOptionByDesired(desired, (r.value || "") + " " + (r.closest("label")?.innerText || "")));
        if (target) {
          target.click();
          target.dispatchEvent(new Event("change", { bubbles: true }));
          touched.push({ question, action: `filled:${desired}`, reason: "matched rule", rule: rule.key, options, selected: desired });
        } else {
          touched.push({ question, action: "unfilled", reason: "rule matched but no option detected", rule: rule.key, options, selected: "(blank)" });
        }
      }

      for (const sel of Array.from(document.querySelectorAll("select"))) {
        const question = getQuestionText(sel);
        const rule = detectRule(question);
        const options = Array.from(sel.options).map((opt) => (opt.text || opt.value || "").trim()).filter(Boolean);
        const selectedText = (sel.options[sel.selectedIndex]?.text || sel.value || "").trim();
        allQuestions.push({ type: "select", question, options, selected: selectedText || "(blank)", matchedRule: rule?.key || "" });
        if (!rule) continue;

        if (sel.value && String(sel.value).trim() !== "") {
          touched.push({ question, action: "kept", reason: "already selected", rule: rule.key, options, selected: selectedText || "(blank)" });
          continue;
        }

        const desired = rule.customAnswer || rule.desired;
        const idx = Array.from(sel.options).findIndex((opt) => pickOptionByDesired(desired, opt.text + " " + opt.value));
        if (idx >= 0) {
          sel.selectedIndex = idx;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          touched.push({ question, action: `filled:${desired}`, reason: "matched rule", rule: rule.key, options, selected: desired });
        } else {
          touched.push({ question, action: "unfilled", reason: "rule matched but no option detected", rule: rule.key, options, selected: "(blank)" });
        }
      }

      for (const input of Array.from(document.querySelectorAll('input[type="text"], input[type="number"], input[type="tel"], input[type="email"], input:not([type]), textarea'))) {
        if (input.disabled || input.readOnly) continue;
        const question = getQuestionText(input);
        const rule = detectRule(question);
        const existing = (input.value || "").trim();
        allQuestions.push({ type: input.tagName.toLowerCase(), question, options: [], selected: existing || "(blank)", matchedRule: rule?.key || "" });
        if (!rule) continue;
        if (existing) {
          touched.push({ question, action: "kept", reason: "already filled", rule: rule.key, options: [], selected: existing });
          continue;
        }
        const desired = rule.customAnswer || rule.desired;
        input.value = desired;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        touched.push({ question, action: `filled:${desired}`, reason: "matched rule", rule: rule.key, options: [], selected: desired });
      }

      return {
        count: touched.length,
        filled: touched.filter((x) => x.action.startsWith("filled")).length,
        kept: touched.filter((x) => x.action === "kept").length,
        unfilled: touched.filter((x) => x.action === "unfilled").length,
        items: touched.slice(0, 40),
        allQuestions: allQuestions.slice(0, 120)
      };
    }
  });

  return result;
}

async function extractApplicationQnA() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("无法获取当前标签页");

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const normalize = (s) => (s || "").replace(/\s+/g, " ").trim();
      const getQuestionText = (el) => {
        const ids = [el.id, el.getAttribute("name")].filter(Boolean);
        for (const id of ids) {
          const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (label?.innerText?.trim()) return normalize(label.innerText);
        }
        const wrapLabel = el.closest("label");
        if (wrapLabel?.innerText?.trim()) return normalize(wrapLabel.innerText);
        const block = el.closest("fieldset, .form-group, .question, .application-question, [role='group']") || el.parentElement;
        return normalize((block?.innerText || "").slice(0, 280));
      };

      const out = [];

      const radioGroups = new Map();
      for (const input of Array.from(document.querySelectorAll('input[type="radio"]'))) {
        const name = input.name || `__anon_${Math.random()}`;
        if (!radioGroups.has(name)) radioGroups.set(name, []);
        radioGroups.get(name).push(input);
      }
      for (const radios of radioGroups.values()) {
        const q = getQuestionText(radios[0]);
        const options = radios.map((r) => normalize((r.closest("label")?.innerText || r.value || ""))).filter(Boolean);
        const selected = radios.find((r) => r.checked);
        const answer = selected ? normalize((selected.closest("label")?.innerText || selected.value || "")) : "";
        out.push({ type: "radio", question: q, options, answer: answer || "(blank)" });
      }

      for (const sel of Array.from(document.querySelectorAll("select"))) {
        const q = getQuestionText(sel);
        const options = Array.from(sel.options).map((o) => normalize(o.text || o.value || "")).filter(Boolean);
        const answer = normalize(sel.options[sel.selectedIndex]?.text || sel.value || "") || "(blank)";
        out.push({ type: "select", question: q, options, answer });
      }

      for (const input of Array.from(document.querySelectorAll('input[type="text"], input[type="number"], input[type="tel"], input[type="email"], input:not([type]), textarea'))) {
        if (input.disabled || input.readOnly) continue;
        const q = getQuestionText(input);
        if (!q) continue;
        const answer = normalize(input.value || "") || "(blank)";
        out.push({ type: input.tagName.toLowerCase(), question: q, options: [], answer });
      }

      return out.slice(0, 140);
    }
  });

  return result;
}

async function runLLMFormReview(formItems, settings, formProfile) {
  const apiKey = settings.apiKey;
  const model = settings.chatModel || "gpt-4.1-mini";

  const prompt = `你是求职申请表单质检助手。请检查问答是否有明显逻辑错误，并只返回 JSON。

输出 schema:
{
  "overall": "ok|needs_review",
  "issues": [
    {
      "question": "string",
      "answer": "string",
      "severity": "high|medium|low",
      "problem": "string",
      "suggestion": "string"
    }
  ],
  "summary": "string"
}

规则：
1) 只抓“明显错误/矛盾/高风险填错”，不要挑语法。
2) 典型冲突示例：
   - legally authorized = No 且 require sponsorship = No（通常矛盾）
   - non-compete 问题答 Yes（可能高风险，建议复核）
   - salary expectation 不合理格式（如空白或非数字）
3) 明确规则："currently/presently authorized to work = Yes" 且 "now or future require sponsorship = Yes" 是常见且合理组合（例如OPT/H-1B路径），不要报错，不要标记风险。
4) 优先对照 expected_profile_answers（用户常见答案偏好），发现和偏好不一致时标记为 medium。
5) 如果没有明显错误，overall=ok，issues=[]。`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: JSON.stringify({ form_items: formItems, expected_profile_answers: formProfile?.profileRules || [] }) }
      ]
    })
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI API错误: ${resp.status} ${text}`);
  }

  const data = await resp.json();
  return JSON.parse(data?.choices?.[0]?.message?.content || "{}");
}

function renderLLMReview(review, formItems) {
  const issues = Array.isArray(review?.issues) ? review.issues : [];
  const issueText = issues.length
    ? issues.map((x, i) => `${i + 1}. Q: ${x.question}\nA: ${x.answer}\nRisk: ${x.severity}\nProblem: ${x.problem}\nSuggestion: ${x.suggestion}`).join("\n\n")
    : "未发现明显错误。";

  resultEl.innerHTML = `
    <div class="item"><div class="label">LLM复核结果</div></div>
    <div class="item">Overall: ${escapeHtml(review?.overall || "ok")}</div>
    <div class="item preline">${escapeHtml(review?.summary || "")}</div>
    <div class="hr"></div>
    <div class="item"><div class="label">Issues</div></div>
    <div class="item preline">${escapeHtml(issueText)}</div>
    <div class="hr"></div>
    <div class="item"><div class="label">读取到的问答</div></div>
    <div class="item preline">${escapeHtml(formItems.map((x, i) => `${i + 1}. ${x.question}\nAnswer: ${x.answer}${x.options?.length ? `\nOptions: ${x.options.join(" | ")}` : ""}`).join("\n\n"))}</div>
  `;
}

function getRiskFlags(question, answer) {
  const q = String(question || "").toLowerCase();
  const a = String(answer || "").toLowerCase();
  const bad = [];
  if ((q.includes("non-compete") || q.includes("non solicit") || q.includes("non-solicit") || q.includes("竞业")) && /\byes\b|是/.test(a)) {
    bad.push("non-compete/non-solicit answered YES");
  }
  if ((q.includes("criminal") || q.includes("crime") || q.includes("felony") || q.includes("犯罪")) && /\byes\b|是/.test(a)) {
    bad.push("criminal history answered YES");
  }
  return bad;
}

function normalizeYN(text) {
  const t = String(text || "").toLowerCase();
  if (/\byes\b|是/.test(t)) return "yes";
  if (/\bno\b|否/.test(t)) return "no";
  return "";
}

function sanitizeReviewIssues(issues, allQuestions) {
  const authorized = allQuestions.find((q) => /authorized to work|work authorization|合法.*工作/.test(String(q.question || "").toLowerCase()));
  const sponsorship = allQuestions.find((q) => /require.*sponsor|future.*sponsor|immigration sponsorship|签证|sponsor/.test(String(q.question || "").toLowerCase()));
  const a = normalizeYN(authorized?.selected || "");
  const s = normalizeYN(sponsorship?.selected || "");

  return (issues || []).filter((x) => {
    const txt = `${x?.question || ""} ${x?.problem || ""}`.toLowerCase();
    if (a === "yes" && s === "yes" && (txt.includes("authorized") || txt.includes("sponsor") || txt.includes("sponsorship") || txt.includes("work authorization"))) {
      return false;
    }
    return true;
  });
}

function renderFormAudit(report, review) {
  const items = report?.items || [];
  const allQuestions = report?.allQuestions || [];
  const issues = sanitizeReviewIssues(Array.isArray(review?.issues) ? review.issues : [], allQuestions);

  const localRisks = [];
  for (const q of allQuestions) {
    const flags = getRiskFlags(q.question, q.selected);
    if (flags.length) localRisks.push({ question: q.question, answer: q.selected, flags });
  }

  const riskHtml = [
    ...localRisks.map((r) => `<div class="risk preline">⚠️ ${escapeHtml(r.flags.join("; "))}\nQ: ${escapeHtml(r.question || "") }\nA: ${escapeHtml(r.answer || "")}</div>`),
    ...issues.map((x) => `<div class="risk preline">⚠️ [${escapeHtml(x.severity || "medium")}] ${escapeHtml(x.problem || "") }\nQ: ${escapeHtml(x.question || "") }\nA: ${escapeHtml(x.answer || "") }\nSuggestion: ${escapeHtml(x.suggestion || "") }</div>`)
  ].join("<div style=\"height:6px\"></div>");

  const displayedOverall = issues.length ? (review?.overall || "needs_review") : "ok";

  resultEl.innerHTML = `
    <div class="item"><div class="label">申请表一键检查结果</div></div>
    <div class="item">已处理问题数: ${report?.count || 0}</div>
    <div class="item">自动填写: ${report?.filled || 0}</div>
    <div class="item">保持原答案: ${report?.kept || 0}</div>
    <div class="item">未能自动填充: ${report?.unfilled || 0}</div>
    <div class="item">LLM复核: ${escapeHtml(displayedOverall)}</div>
    <div class="hr"></div>
    <div class="item"><div class="label">不利答案高亮（重点）</div></div>
    <div class="item">${riskHtml || "未发现明显不利答案"}</div>
    <div class="hr"></div>
    <div class="item"><div class="label">规则命中详情</div></div>
    <div class="item preline">${items.length ? escapeHtml(items.map((x, i) => `${i + 1}. [${x.rule}] ${x.action}\nQ: ${x.question || "(no question text)"}\nOptions: ${(x.options || []).join(" | ") || "(n/a)"}\nSelected: ${x.selected || "(blank)"}`).join("\n\n")) : "未找到匹配规则的问题"}</div>
    <div class="hr"></div>
    <div class="item"><div class="label">页面读取到的全部问题与答案</div></div>
    <div class="item preline">${allQuestions.length ? escapeHtml(allQuestions.map((q, i) => `${i + 1}. [${q.type}] ${q.question || "(no question text)"}\nOptions: ${(q.options || []).join(" | ") || "(n/a)"}\nSelected: ${q.selected || "(blank)"}${q.matchedRule ? `\nRule: ${q.matchedRule}` : ""}`).join("\n\n")) : "未读取到问题"}</div>
  `;
}

async function analyzeWithOpenAI(payload, settings) {
  const apiKey = settings.apiKey;
  const model = settings.chatModel || "gpt-4.1-mini";

  const prompt = `你是求职分析助手。请严格输出 JSON，不要输出 markdown。

输出 schema：
{
  "salary_range": {
    "value": "string",
    "confidence": "high|medium|low",
    "evidence": "string"
  },
  "visa_sponsorship": {
    "value": "yes|no|na",
    "confidence": "high|medium|low",
    "evidence": "string"
  },
  "why_this_company": "string",
  "why_this_role": "string",
  "resume_used": ["string"],
  "notes": "string"
}

规则：
1) salary_range 仅在页面有明确薪资时给范围，否则 unknown。
2) visa_sponsorship 只允许 yes/no/na。
3) 关于 visa_sponsorship：忽略申请表问句、候选人需勾选的题目、FAQ模板题（例如“Are you legally authorized...”“Will you now or in the future require sponsorship...”及其 Yes/No 选项）。这些不提供公司政策信息，不能作为证据。
4) 只有在页面出现公司政策性陈述时，才判断 sponsorship（例如“we do/do not sponsor visas”）。若没有明确公司政策，返回 na。
5) why_this_company 和 why_this_role 必须同时引用：
   - 页面里的岗位/公司信息；
   - 候选人简历片段中的具体经历/技能（至少1个具体点）。
6) resume_used 填你实际用到的简历关键词或经历要点（2-5条）。
7) 不要编造证据；evidence尽量引用页面原句关键片段。`; 

  const userContent = {
    page: {
      title: payload.pageTitle,
      url: payload.url,
      text: payload.pageText
    },
    resume_retrieved_chunks: payload.resumeChunks
  };

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: JSON.stringify(userContent) }
      ]
    })
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI API错误: ${resp.status} ${text}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI 响应为空");

  return JSON.parse(content);
}

function visaBadge(value) {
  const v = String(value || "na").toLowerCase();
  if (v === "yes") return `<span class="badge badge-yes">YES SPONSOR</span>`;
  if (v === "no") return `<span class="badge badge-no">NO SPONSOR</span>`;
  return `<span class="badge badge-na">N/A</span>`;
}

function renderResult(json) {
  const salary = json.salary_range || {};
  const visa = json.visa_sponsorship || {};
  const resumeUsed = Array.isArray(json.resume_used) ? json.resume_used : [];

  resultEl.innerHTML = `
    <div class="item">
      <div class="label">Salary Range</div>
      <div class="preline">${escapeHtml(salary.value || "unknown")}</div>
      <div class="muted">confidence: ${escapeHtml(salary.confidence || "low")}</div>
      <div class="muted preline">evidence: ${escapeHtml(salary.evidence || "")}</div>
    </div>

    <div class="hr"></div>

    <div class="item">
      <div class="label">Visa Sponsorship</div>
      ${visaBadge(visa.value)}
      <div class="muted">confidence: ${escapeHtml(visa.confidence || "low")}</div>
      <div class="muted preline">evidence: ${escapeHtml(visa.evidence || "")}</div>
    </div>

    <div class="hr"></div>

    <div class="item">
      <div class="label">Why this company</div>
      <div class="preline">${escapeHtml(json.why_this_company || "")}</div>
    </div>

    <div class="item">
      <div class="label">Why this role</div>
      <div class="preline">${escapeHtml(json.why_this_role || "")}</div>
    </div>

    <div class="item">
      <div class="label">Resume points used</div>
      <div class="preline">${resumeUsed.length ? escapeHtml(resumeUsed.join("\n• ")).replace(/^/, "• ") : "(none)"}</div>
    </div>

    ${json.notes ? `<div class="item"><div class="label">Notes</div><div class="preline">${escapeHtml(json.notes)}</div></div>` : ""}
  `;
}

async function saveLastResult(payload) {
  await chrome.storage.local.set({ [LAST_RESULT_KEY]: payload });
}

async function loadLastResult() {
  const data = await chrome.storage.local.get([LAST_RESULT_KEY]);
  return data?.[LAST_RESULT_KEY] || null;
}

async function renderLastResultOnOpen() {
  const last = await loadLastResult();
  if (!last?.result) return;

  renderResult(last.result);
  const when = last.createdAt ? new Date(last.createdAt).toLocaleString() : "";
  const pagePart = last.url ? ` | ${last.url}` : "";
  setStatus(`已加载上次结果${when ? `（${when}）` : ""}${pagePart}`);
}

async function handleAnalyze() {
  analyzeBtn.disabled = true;
  setStatus("读取页面中...");
  resultEl.innerHTML = "";

  try {
    const settings = await chrome.storage.local.get(["apiKey", "chatModel", "topK", "resumeChunks"]);
    if (!settings.apiKey) {
      throw new Error("请先在设置页填写 OpenAI API Key");
    }

    const page = await getCurrentPageText();
    const pageText = `${page.title}\n${page.bodyText}`;
    const resumeChunks = retrieveResumeChunks(pageText, settings.resumeChunks || [], settings.topK || 4);

    setStatus(`调用 OpenAI 分析中...（简历召回 ${resumeChunks.length} 段）`);
    const json = await analyzeWithOpenAI({
      pageTitle: page.title,
      url: page.url,
      pageText,
      resumeChunks
    }, settings);

    setStatus("分析完成", false);
    statusEl.classList.add("ok");
    renderResult(json);
    await saveLastResult({
      createdAt: Date.now(),
      url: page.url,
      pageTitle: page.title,
      result: json
    });
  } catch (err) {
    setStatus("分析失败", true);
    resultEl.textContent = err?.message || String(err);
  } finally {
    analyzeBtn.disabled = false;
  }
}

async function handleFillForm() {
  fillFormBtn.disabled = true;
  setStatus("检查、填充并复核中...");
  try {
    const settings = await chrome.storage.local.get(["apiKey", "chatModel", "formProfile"]);
    if (!settings.apiKey) throw new Error("请先在设置页填写 OpenAI API Key");

    const formProfile = parseFormProfile(settings.formProfile);
    const report = await checkAndFillApplicationForm(formProfile);
    const formItems = await extractApplicationQnA();
    const review = await runLLMFormReview(formItems, settings, formProfile);

    setStatus(`完成：自动填写 ${report.filled} 项，复核 ${review?.overall || "ok"}`);
    statusEl.classList.add("ok");
    renderFormAudit(report, review);
  } catch (err) {
    setStatus("一键检查失败", true);
    resultEl.textContent = err?.message || String(err);
  } finally {
    fillFormBtn.disabled = false;
  }
}

analyzeBtn.addEventListener("click", handleAnalyze);
fillFormBtn.addEventListener("click", handleFillForm);
openOptionsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
renderLastResultOnOpen();
