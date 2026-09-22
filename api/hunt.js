// api/hunt.js
// Vercel Serverless Function
// Flow: JD -> Exa (tìm profile thật trên nhiều nền tảng) -> Gemini (trích xuất + chấm điểm)

const EXA_ENDPOINT = "https://api.exa.ai/search";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Exa search helper ----
async function exaSearch(body, apiKey) {
  const res = await fetch(EXA_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Exa API error (${res.status}): ${errText}`);
  }
  return res.json();
}

// Gom nhiều search khác nhau trên nhiều nền tảng
async function huntProfiles({ position, location, skills, jd }, exaKey, perPlatform) {
  const skillStr = (skills || "").trim();
  const loc = (location || "").trim();

  // Câu query semantic cho "people" (tổng hợp 1B+ profile gồm cả LinkedIn)
  const peopleQuery =
    `${position} ${skillStr ? "skilled in " + skillStr : ""} ${loc ? "based in " + loc : "in Vietnam"}`.trim();

  // Các nền tảng tuyển dụng / dev VN + portfolio dùng domain-restricted search
  const domainQuery =
    `${position} developer resume profile ${skillStr} ${loc || "Vietnam"}`.trim();

  const tasks = [
    // 1) Exa People Search (LinkedIn + web professional profiles)
    exaSearch(
      {
        query: peopleQuery,
        category: "people",
        numResults: perPlatform,
        contents: { text: { maxCharacters: 1200 }, highlights: true },
      },
      exaKey
    ).then((r) => tag(r, "People / LinkedIn")).catch((e) => softFail("People", e)),

    // 2) GitHub
    exaSearch(
      {
        query: `${position} ${skillStr} developer Vietnam`,
        type: "auto",
        numResults: perPlatform,
        includeDomains: ["github.com"],
        contents: { text: { maxCharacters: 1200 }, highlights: true },
      },
      exaKey
    ).then((r) => tag(r, "GitHub")).catch((e) => softFail("GitHub", e)),

    // 3) TopDev
    exaSearch(
      {
        query: domainQuery,
        type: "auto",
        numResults: perPlatform,
        includeDomains: ["topdev.vn"],
        contents: { text: { maxCharacters: 1200 }, highlights: true },
      },
      exaKey
    ).then((r) => tag(r, "TopDev")).catch((e) => softFail("TopDev", e)),

    // 4) Vieclam24h
    exaSearch(
      {
        query: domainQuery,
        type: "auto",
        numResults: perPlatform,
        includeDomains: ["vieclam24h.vn"],
        contents: { text: { maxCharacters: 1200 }, highlights: true },
      },
      exaKey
    ).then((r) => tag(r, "Vieclam24h")).catch((e) => softFail("Vieclam24h", e)),

    // 5) Ybox + portfolio (personal sites)
    exaSearch(
      {
        query: `${position} ${skillStr} portfolio personal website Vietnam`,
        type: "auto",
        numResults: perPlatform,
        includeDomains: ["ybox.vn", "dev.to", "medium.com", "gitlab.com", "behance.net", "dribbble.com"],
        contents: { text: { maxCharacters: 1200 }, highlights: true },
      },
      exaKey
    ).then((r) => tag(r, "Portfolio / Other")).catch((e) => softFail("Portfolio", e)),
  ];

  const settled = await Promise.all(tasks);
  // Gộp và gắn nền tảng
  const merged = [];
  for (const group of settled) {
    for (const item of group.results || []) {
      merged.push({
        platform: group._platform,
        url: item.url,
        title: item.title,
        author: item.author || null,
        text: item.text || "",
        highlights: (item.highlights || []).join(" ").slice(0, 800),
      });
    }
  }

  // Loại trùng theo URL
  const seen = new Set();
  const unique = merged.filter((m) => {
    if (!m.url || seen.has(m.url)) return false;
    seen.add(m.url);
    return true;
  });

  return unique;
}

function tag(r, platform) {
  return { ...r, _platform: platform };
}
function softFail(platform, e) {
  console.error(`[${platform}] search failed:`, e.message);
  return { results: [], _platform: platform, _error: e.message };
}

// ---- Gemini scoring (free tier) ----
async function scoreWithGemini({ jd, position, skills, minExperience, location, candidates }, geminiKey) {
  const compact = candidates.map((c, i) => ({
    idx: i,
    platform: c.platform,
    url: c.url,
    title: c.title,
    author: c.author,
    snippet: (c.text + " " + c.highlights).slice(0, 900),
  }));

  const system = `Bạn là chuyên gia tuyển dụng. Nhiệm vụ: từ các đoạn dữ liệu profile thô (đã thu thập từ nhiều nền tảng qua công cụ search), hãy TRÍCH XUẤT thông tin ứng viên và CHẤM ĐIỂM độ phù hợp với Job Description.

Trả về DUY NHẤT một JSON hợp lệ, KHÔNG có markdown, KHÔNG có text ngoài JSON, theo schema:
{
  "candidates": [
    {
      "idx": <số idx gốc>,
      "name": "<tên hoặc 'Không rõ'>",
      "email": "<email nếu xuất hiện trong dữ liệu, else ''>",
      "phone": "<sđt nếu có, else ''>",
      "current_company": "<công ty hiện tại hoặc ''>",
      "current_position": "<vị trí hiện tại hoặc ''>",
      "location": "<nơi ở/làm việc hoặc ''>",
      "status": "<'Đang tìm việc'|'Đang làm việc'|'Open to opportunities'|'Không rõ'>",
      "skills": ["<kỹ năng>", ...],
      "score": <0-100 số nguyên>,
      "breakdown": { "skills": <0-100>, "experience": <0-100>, "status": <0-100>, "location": <0-100> },
      "reason": "<1-2 câu vì sao phù hợp/không>",
      "profile_url": "<url gốc>",
      "platform": "<nền tảng>"
    }
  ]
}

QUY TẮC:
- CHỈ dùng thông tin có trong dữ liệu. Không bịa email/sđt. Nếu không có thì để chuỗi rỗng.
- BẮT BUỘC: mỗi mục trong dữ liệu đầu vào (mỗi idx) PHẢI xuất hiện trong "candidates" của kết quả, kể cả khi thông tin rất ít hoặc không rõ có phù hợp hay không — trong trường hợp đó vẫn chấm điểm (có thể thấp) và ghi rõ trong "reason" là thiếu dữ liệu để đánh giá chính xác. Không được tự ý bỏ bớt idx nào.
- CHỈ bỏ qua một idx nếu chắc chắn 100% đó KHÔNG phải trang cá nhân/profile của một người cụ thể (vd trang chủ công ty chung chung, bài báo tin tức, trang danh sách nhiều job không gắn với 1 ứng viên). Khi bỏ qua, vẫn phải đưa idx đó vào kết quả với score=0 và reason giải thích lý do loại, để tổng số candidates trong kết quả LUÔN BẰNG tổng số mục trong dữ liệu đầu vào.
- score = 0.4*skills + 0.3*experience + 0.15*status + 0.15*location (làm tròn).
- Sắp xếp candidates theo score giảm dần.`;

  const user = `JOB DESCRIPTION:
${jd}

Vị trí: ${position}
Kỹ năng yêu cầu: ${skills || "(suy ra từ JD)"}
Kinh nghiệm tối thiểu: ${minExperience} năm
Nơi làm việc ưu tiên: ${location || "(không bắt buộc)"}

DỮ LIỆU PROFILE THÔ (JSON):
${JSON.stringify(compact)}`;

  async function callGemini() {
    return fetch(GEMINI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": geminiKey,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 65536,
          responseMimeType: "application/json",
        },
      }),
    });
  }

  // Retry với backoff cho lỗi tạm thời (503 quá tải / 429 rate limit / 500)
  let res;
  let lastErrText = "";
  const maxRetries = 4;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    res = await callGemini();
    if (res.ok) break;

    const retryable = res.status === 503 || res.status === 429 || res.status === 500;
    lastErrText = await res.text();

    if (!retryable || attempt === maxRetries) {
      throw new Error(`Gemini API error (${res.status}): ${lastErrText}`);
    }

    const delay = 1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 300);
    console.warn(`Gemini ${res.status}, retry ${attempt + 1}/${maxRetries} sau ${delay}ms`);
    await sleep(delay);
  }

  const data = await res.json();
  const textOut = (data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("")
    .trim();

  if (!textOut) {
    throw new Error("Gemini không trả về nội dung. Có thể bị rate limit (thử lại sau vài giây).");
  }

  // Parse JSON an toàn (gỡ bỏ ```json nếu có)
  const cleaned = textOut.replace(/```json/gi, "").replace(/```/g, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) parsed = JSON.parse(match[0]);
    else throw new Error("Không parse được JSON từ Gemini: " + cleaned.slice(0, 300));
  }
  return parsed.candidates || [];
}

// ---- Main handler ----
export default async function handler(req, res) {
  // CORS (cho phép gọi từ chính domain; * để test dễ)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const exaKey = process.env.EXA_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!exaKey || !geminiKey) {
    return res.status(500).json({
      error: "Thiếu API key. Hãy set EXA_API_KEY và GEMINI_API_KEY trong Environment Variables của Vercel.",
    });
  }

  try {
    // body có thể là string trên một số runtime
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const {
      jd = "",
      position = "",
      location = "",
      skills = "",
      minExperience = 3,
      perPlatform = 15,
    } = body;

    if (!jd || !position) {
      return res.status(400).json({ error: "Cần có 'jd' và 'position'." });
    }

    // 1) Hunt profile thật từ nhiều nền tảng
    const rawCandidates = await huntProfiles(
      { position, location, skills, jd },
      exaKey,
      Math.min(Math.max(parseInt(perPlatform) || 15, 3), 20)
    );

    if (rawCandidates.length === 0) {
      return res.status(200).json({
        candidates: [],
        meta: { found_raw: 0, note: "Exa không trả về kết quả nào. Thử nới lỏng vị trí/kỹ năng." },
      });
    }

    // 2) Gemini trích xuất + chấm điểm
    const scored = await scoreWithGemini(
      { jd, position, skills, minExperience, location, candidates: rawCandidates },
      geminiKey
    );

    // Ghép lại url gốc theo idx (đề phòng Gemini thiếu)
    const enriched = scored.map((c) => {
      const src = rawCandidates[c.idx] || {};
      return {
        ...c,
        profile_url: c.profile_url || src.url || "",
        platform: c.platform || src.platform || "",
      };
    });

    enriched.sort((a, b) => (b.score || 0) - (a.score || 0));

    return res.status(200).json({
      candidates: enriched,
      meta: {
        found_raw: rawCandidates.length,
        scored: enriched.length,
        model: GEMINI_MODEL,
      },
    });
  } catch (err) {
    console.error("Hunt error:", err);
    return res.status(500).json({ error: err.message || "Lỗi không xác định" });
  }
}
