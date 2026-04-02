# Job Lens AI (Chrome Extension)

一个用于求职页面快速分析的 Chrome 插件：

1. salary range
2. visa sponsorship（yes / no / na）
3. 结合简历（本地 RAG）输出简短的 why this company / why this role

## 功能说明

- **读取当前页面**：抓取 title + body 文本（截断到 30k 字符）
- **本地 RAG**：简历文本切块保存在浏览器本地，先做关键词召回 topK，再把少量片段发给 OpenAI
- **结构化输出**：强制 JSON schema，结果里包含置信度和证据摘要

## 安装

1. 打开 `chrome://extensions`
2. 开启右上角 **Developer mode**
3. 点击 **Load unpacked**
4. 选择本目录 `job-hunt-chrome-extension`
5. 点击插件图标会在右侧打开 Side Panel（不会因点击页面其他位置自动关闭）

## 使用

1. 先点插件里的 **设置**，填写：
   - OpenAI API Key
   - 模型（默认 `gpt-4.1-mini`）
   - 简历文本（粘贴）
2. 打开任意职位 JD 页面
3. 点击 **分析当前职位页面**

## 注意

- 当前版本是 MVP：RAG 用本地关键词召回，不依赖向量库
- 如需更强的 RAG，可升级到 embedding + cosine 相似度
- 插件将 API Key 存在 `chrome.storage.local`（仅本地）
