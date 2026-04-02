const $ = (id) => document.getElementById(id);

const apiKeyEl = $("apiKey");
const chatModelEl = $("chatModel");
const topKEl = $("topK");
const resumeTextEl = $("resumeText");
const formProfileEl = $("formProfile");
const templateBtn = $("templateBtn");
const saveBtn = $("saveBtn");
const saveStatus = $("saveStatus");

const DEFAULT_FORM_PROFILE = {
  profileRules: [
    { keywords: ["legally authorized to work"], answer: "Yes" },
    { keywords: ["require sponsorship", "future"], answer: "Yes" },
    { keywords: ["non-compete"], answer: "No" },
    { keywords: ["non-solicit"], answer: "No" },
    { keywords: ["criminal", "history"], answer: "No" },
    { keywords: ["gender"], answer: "Male" },
    { keywords: ["ethnicity"], answer: "Asian (Not Hispanic or Latino)" },
    { keywords: ["hispanic or latino"], answer: "No" },
    { keywords: ["veteran"], answer: "I AM NOT A VETERAN" },
    { keywords: ["disability"], answer: "I do not want to answer" },
    { keywords: ["language"], answer: "English" },
    { keywords: ["name"], answer: "YOUR_NAME" },
    { keywords: ["salary expectations"], answer: "YOUR_SALARY_EXPECTATION" },
    { keywords: ["notice period"], answer: "YOUR_NOTICE_PERIOD" },
    { keywords: ["terms and conditions"], answer: "Yes" }
  ]
};

function chunkResume(text, chunkSize = 1000, overlap = 200) {
  const clean = (text || "").replace(/\r/g, "").trim();
  if (!clean) return [];

  const chunks = [];
  let i = 0;
  while (i < clean.length) {
    const end = Math.min(clean.length, i + chunkSize);
    chunks.push(clean.slice(i, end));
    if (end === clean.length) break;
    i = Math.max(0, end - overlap);
  }
  return chunks;
}

async function loadSettings() {
  const data = await chrome.storage.local.get(["apiKey", "chatModel", "topK", "resumeText", "formProfile"]);
  apiKeyEl.value = data.apiKey || "";
  chatModelEl.value = data.chatModel || "gpt-4.1-mini";
  topKEl.value = data.topK || 4;
  resumeTextEl.value = data.resumeText || "";
  formProfileEl.value = data.formProfile || JSON.stringify(DEFAULT_FORM_PROFILE, null, 2);
}

async function saveSettings() {
  saveStatus.className = "";
  saveStatus.textContent = "保存中...";

  try {
    const apiKey = apiKeyEl.value.trim();
    const chatModel = chatModelEl.value;
    const topK = Math.max(1, Math.min(12, Number(topKEl.value || 4)));
    const resumeText = resumeTextEl.value.trim();
    const resumeChunks = chunkResume(resumeText);

    const rawProfile = formProfileEl.value.trim();
    JSON.parse(rawProfile || "{}");

    await chrome.storage.local.set({
      apiKey,
      chatModel,
      topK,
      resumeText,
      resumeChunks,
      formProfile: rawProfile
    });

    saveStatus.className = "ok";
    saveStatus.textContent = `已保存（${resumeChunks.length} 个简历片段）`;
  } catch (err) {
    saveStatus.className = "err";
    saveStatus.textContent = `保存失败: ${err?.message || String(err)}`;
  }
}

templateBtn.addEventListener("click", () => {
  formProfileEl.value = JSON.stringify(DEFAULT_FORM_PROFILE, null, 2);
});
saveBtn.addEventListener("click", saveSettings);
loadSettings();
