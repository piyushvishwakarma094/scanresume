/* ATS Resume Analyzer Pro - Client-side app */

// Configure pdf.js worker
if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
}

// ---------- DOM Elements ----------
const els = {
    form: document.getElementById('resumeForm'),
    fileInput: document.getElementById('resume'),
    dropzone: document.getElementById('dropzone'),
    pickFile: document.getElementById('pickFile'),
    fileInfo: document.getElementById('fileInfo'),
    jobDescription: document.getElementById('jobDescription'),
    customKeywords: document.getElementById('customKeywords'),
    report: document.getElementById('report'),
    exportActions: document.getElementById('exportActions'),
    downloadReport: document.getElementById('downloadReport'),
    printReport: document.getElementById('printReport'),
    useSampleResume: document.getElementById('useSampleResume'),
    useSampleJD: document.getElementById('useSampleJD'),
    resetForm: document.getElementById('resetForm'),
    aiEnabled: null,
    aiProvider: null,
    aiModel: null,
    aiApiKey: null,
    aiApiBase: null,
    aiStatus: null,
    aiGenerateSummary: document.getElementById('aiGenerateSummary'),
    aiGenerateBullets: document.getElementById('aiGenerateBullets')
};

let currentFile = null; // Holds the uploaded File object

// ---------- Utilities ----------
const bytesToSize = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const sanitizeHTML = (str) => {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
};

const nl2br = (str) => sanitizeHTML(str).replace(/\n/g, '<br/>');

const debounce = (fn, wait = 300) => {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), wait);
    };
};

const stopwords = new Set([
    'and','or','the','a','an','to','of','in','on','for','with','by','is','are','as','at','from','this','that','be','it','which','we','you','your','our',
    'will','can','should','must','may','not','into','per','via','using','use','used','including','include','includes','etc','over','under','within',
    'ability','experience','responsibilities','requirements','preferred','years','year','plus','strong','good','excellent','familiarity','knowledge'
]);

// ---------- File Handling ----------
function showFileInfo(file) {
    if (!file) {
        els.fileInfo.textContent = '';
        return;
    }
    els.fileInfo.textContent = `${file.name} (${bytesToSize(file.size)})`;
}

function pickFile() {
    els.fileInput.click();
}

function attachDropzone() {
    const dz = els.dropzone;
    dz.addEventListener('click', () => pickFile());
    dz.addEventListener('keypress', (e) => { if (e.key === 'Enter' || e.key === ' ') pickFile(); });

    ;['dragenter','dragover'].forEach(evt => dz.addEventListener(evt, (e) => {
        e.preventDefault(); e.stopPropagation();
        dz.classList.add('dragover');
    }));

    ;['dragleave','drop'].forEach(evt => dz.addEventListener(evt, (e) => {
        e.preventDefault(); e.stopPropagation();
        dz.classList.remove('dragover');
    }));

    dz.addEventListener('drop', (e) => {
        const files = e.dataTransfer.files;
        if (files && files[0]) {
            currentFile = files[0];
            showFileInfo(currentFile);
        }
    });
}

function attachFileInput() {
    els.pickFile?.addEventListener('click', pickFile);
    els.fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        currentFile = file || null;
        showFileInfo(currentFile);
    });
}

function setBusy(busy) {
    const btn = els.form.querySelector('button[type="submit"]');
    if (!btn) return;
    btn.disabled = busy;
    btn.textContent = busy ? 'Analyzing…' : 'Analyze Resume';
    if (els.aiGenerateSummary) els.aiGenerateSummary.disabled = busy;
    if (els.aiGenerateBullets) els.aiGenerateBullets.disabled = busy;
}

function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsText(file);
    });
}

function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
    });
}

async function parsePDF(file) {
    try {
        const data = await readFileAsArrayBuffer(file);
        const pdf = await pdfjsLib.getDocument({ data }).promise;
        let text = '';
        const numPages = pdf.numPages;
        for (let i = 1; i <= numPages; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            const items = content.items || [];
            const pageText = items.map(it => it.str).join(' ');
            text += pageText + '\n';
        }
        return text;
    } catch (err) {
        console.error('PDF parse error:', err);
        throw new Error('Failed to parse PDF. Ensure the file is not corrupted.');
    }
}

async function parseDOCX(file) {
    try {
        const arrayBuffer = await readFileAsArrayBuffer(file);
        const result = await mammoth.extractRawText({ arrayBuffer });
        return result.value || '';
    } catch (err) {
        console.error('DOCX parse error:', err);
        throw new Error('Failed to parse DOCX. Only .docx is supported, not .doc.');
    }
}

function detectFileKind(file) {
    const name = (file?.name || '').toLowerCase();
    const type = (file?.type || '').toLowerCase();
    if (name.endsWith('.pdf') || type === 'application/pdf') return 'pdf';
    if (name.endsWith('.docx') || type.includes('officedocument.wordprocessingml.document')) return 'docx';
    if (name.endsWith('.txt') || type === 'text/plain') return 'txt';
    if (name.endsWith('.doc')) return 'doc';
    return 'unknown';
}

// ---------- Analysis ----------
function normalizeText(s) {
    return (s || '').replace(/\r/g, '').replace(/\t/g, ' ').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

function splitWords(s) {
    return (s || '').toLowerCase().split(/[^a-z0-9+#.]/i).filter(Boolean);
}

function computeStats(text) {
    const clean = normalizeText(text);
    const lines = clean.split(/\n+/);
    const words = splitWords(clean);
    const wordCount = words.length;
    const estimatedPages = Math.max(1, Math.round(wordCount / 500));
    const readingTimeMin = Math.max(1, Math.round(wordCount / 200));
    const bulletLines = lines.filter(l => /^\s*[-*•]/.test(l)).length;

    const emails = (clean.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).length;
    const phones = (clean.match(/(\+?\d{1,3}?[-.\s]?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4})/g) || []).length;
    const links = (clean.match(/https?:\/\/\S+/g) || []).length;
    const dates = (clean.match(/(?:\b\d{4}\b)|(?:\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\b)/gi) || []).length;

    return { wordCount, estimatedPages, readingTimeMin, bulletLines, emails, phones, links, dates };
}

function detectContactInfo(text) {
    const clean = normalizeText(text);
    const email = (clean.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [])[0] || '';
    const phone = (clean.match(/(\+?\d{1,3}?[-.\s]?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4})/) || [])[0] || '';
    const linkedin = (clean.match(/https?:\/\/(?:www\.)?linkedin\.com\/[^\s)]+/i) || [])[0] || '';
    const github = (clean.match(/https?:\/\/(?:www\.)?github\.com\/[^\s)]+/i) || [])[0] || '';
    const portfolio = (clean.match(/https?:\/\/(?!.*linkedin|github)\S+\.[a-z]{2,}\/?\S*/i) || [])[0] || '';
    return { email, phone, linkedin, github, portfolio };
}

function extractSections(text) {
    const clean = normalizeText(text);
    const headingPatterns = [
        { key: 'summary', rx: /\n?\s*(?:summary|profile|about me)\s*\n/gi },
        { key: 'skills', rx: /\n?\s*(?:skills|technical skills|core competencies)\s*\n/gi },
        { key: 'experience', rx: /\n?\s*(?:experience|work experience|professional experience|employment history)\s*\n/gi },
        { key: 'education', rx: /\n?\s*(?:education|academics|academic background)\s*\n/gi },
        { key: 'projects', rx: /\n?\s*(?:projects|personal projects|selected projects)\s*\n/gi },
        { key: 'certifications', rx: /\n?\s*(?:certifications|licenses|certifications & licenses)\s*\n/gi },
        { key: 'awards', rx: /\n?\s*(?:awards|honors|achievements)\s*\n/gi }
    ];

    // Find all headings with their indices
    const indices = [];
    headingPatterns.forEach(h => {
        let m;
        while ((m = h.rx.exec('\n' + clean)) !== null) {
            indices.push({ key: h.key, index: m.index });
        }
    });

    indices.sort((a, b) => a.index - b.index);

    const sections = {};
    for (let i = 0; i < indices.length; i++) {
        const { key, index } = indices[i];
        const start = index;
        const end = (i + 1 < indices.length) ? indices[i + 1].index : clean.length;
        sections[key] = clean.slice(start, end).trim();
    }

    // Fallback minimal extraction if not found
    const contact = detectContactInfo(clean);
    return { ...sections, contact };
}

function extractKeywordsFromJD(jdText, customList) {
    const jd = normalizeText(jdText).toLowerCase();
    const tokens = jd.split(/[^a-z0-9+#.]/).filter(Boolean);

    // frequency map ignoring stopwords and short tokens
    const freq = new Map();
    for (const t of tokens) {
        if (stopwords.has(t) || t.length < 2) continue;
        freq.set(t, (freq.get(t) || 0) + 1);
    }

    // Seed with common tech words if present
    const prefer = [
        'javascript','typescript','react','node','node.js','nodejs','express','angular','vue',
        'python','django','flask','pandas','numpy','ml','machine','learning',
        'java','spring','springboot','kotlin','scala',
        'c#','dotnet','.net','asp.net',
        'go','golang',
        'php','laravel','symfony',
        'ruby','rails',
        'sql','mysql','postgres','postgresql','mssql','oracle','sqlite','nosql','mongodb','redis','elasticsearch',
        'aws','azure','gcp','docker','kubernetes','k8s','terraform','ci/cd','jenkins','git',
        'graphql','rest','microservices','serverless','kafka','rabbitmq',
        'html','css','sass','less','tailwind','bootstrap',
        'data','analysis','etl','airflow','dbt','powerbi','tableau'
    ];

    prefer.forEach(k => {
        if (jd.includes(k)) freq.set(k, (freq.get(k) || 0) + 3);
    });

    // Merge custom keywords
    const custom = (customList || []).map(k => k.trim().toLowerCase()).filter(Boolean);
    custom.forEach(k => freq.set(k, (freq.get(k) || 0) + 5));

    // Select top keywords
    const sorted = Array.from(freq.entries()).sort((a,b) => b[1] - a[1]);
    const unique = [];
    const seen = new Set();
    for (const [k] of sorted) {
        const canonical = k.replace(/\.+$/, '');
        if (!seen.has(canonical) && canonical.length >= 2) {
            unique.push(canonical);
            seen.add(canonical);
        }
        if (unique.length >= 40) break;
    }

    return unique;
}

function matchKeywords(resumeText, keywords) {
    const text = normalizeText(resumeText).toLowerCase();
    const found = [];
    const missing = [];

    // Create a set of words for quick match but also allow substring for technologies
    const bag = new Set(splitWords(text));
    const textLC = text;

    for (const kw of keywords) {
        const k = kw.toLowerCase();
        const exact = bag.has(k);
        const loose = !exact && textLC.includes(k);
        if (exact || loose) found.push(kw);
        else missing.push(kw);
    }

    return { found, missing };
}

function computeScore(components) {
    const { sections, keywordMatch, stats, contact } = components;

    // Structure score (30)
    let structure = 0;
    if (sections.experience) structure += 8;
    if (sections.education) structure += 7;
    if (sections.skills) structure += 8;
    if (sections.summary) structure += 4;
    if (sections.projects || sections.certifications) structure += 3;

    // Contact presence (5)
    let contactScore = 0;
    if (contact.email) contactScore += 2;
    if (contact.phone) contactScore += 2;
    if (contact.linkedin || contact.github || contact.portfolio) contactScore += 1;

    // Keyword coverage (50)
    const totalKw = keywordMatch.found.length + keywordMatch.missing.length;
    const coverage = totalKw > 0 ? (keywordMatch.found.length / totalKw) : 0;
    const keywordScore = Math.round(coverage * 50);

    // Formatting & sanity (15)
    let fmt = 0;
    if (stats.wordCount >= 350 && stats.wordCount <= 1200) fmt += 6; // reasonable length
    if (stats.bulletLines >= 5) fmt += 4; // bullet usage
    if (stats.dates >= 3) fmt += 3; // shows timeline
    if (stats.emails >= 1 || stats.phones >= 1) fmt += 2; // contact detect

    const raw = structure + contactScore + keywordScore + fmt; // 0..100
    const score = Math.max(0, Math.min(100, Math.round(raw)));

    let label = 'Poor';
    if (score >= 85) label = 'Excellent';
    else if (score >= 70) label = 'Good';
    else if (score >= 55) label = 'Fair';

    return { score, label, coverage };
}

function generateSuggestions(components) {
    const { sections, keywordMatch, stats, contact } = components;
    const suggestions = [];

    // Missing sections
    if (!sections.experience) suggestions.push("Add a 'Work Experience' section with role, company, dates, and achievements.");
    if (!sections.education) suggestions.push("Add an 'Education' section with degree, institution, and graduation date.");
    if (!sections.skills) suggestions.push("Add a 'Skills' section listing relevant technologies and tools.");
    if (!sections.summary) suggestions.push("Add a brief professional summary at the top tailored to the job.");

    // Contact
    if (!contact.email) suggestions.push('Include a professional email address.');
    if (!contact.phone) suggestions.push('Include a reachable phone number with country/area code.');
    if (!contact.linkedin && !contact.github && !contact.portfolio) suggestions.push('Add a LinkedIn, GitHub, or portfolio link.');

    // Keywords
    if (keywordMatch.missing.length > 0) {
        const topMissing = keywordMatch.missing.slice(0, 12).join(', ');
        suggestions.push(`Incorporate missing job keywords: ${topMissing}. Mention where applicable.`);
    }

    // Length
    if (stats.wordCount < 350) suggestions.push('Your resume is quite short. Expand content with responsibilities and quantified achievements.');
    if (stats.wordCount > 1200) suggestions.push('Your resume is long. Condense content to 1–2 pages focusing on impact.');

    // Bullets and metrics
    if (stats.bulletLines < 5) suggestions.push('Use bullet points for readability and scannability (aim for 5+).');
    const hasMetrics = /\b(\d+%|\$\d+|\d+k|\d+,\d+|\b\d+\b)\b/.test(components.rawText);
    if (!hasMetrics) suggestions.push('Add metrics to quantify impact (e.g., increased X by Y%, reduced Z by N).');

    // Dates
    if (stats.dates < 3) suggestions.push('Include dates for roles and education to establish a clear timeline.');

    // Action verbs
    const actionVerbs = ['led','built','designed','developed','implemented','optimized','created','launched','migrated','refactored','automated','improved','reduced','increased','delivered'];
    const textLC = components.rawText.toLowerCase();
    const verbCount = actionVerbs.reduce((acc, v) => acc + (textLC.includes(v) ? 1 : 0), 0);
    if (verbCount < 3) suggestions.push('Start bullet points with strong action verbs (e.g., Led, Built, Optimized).');

    return suggestions;
}

// ---------- Rendering ----------
function renderReport(components) {
    const { sections, keywordMatch, stats, score, label, coverage, contact, rawText, keywords } = components;

    const foundHTML = keywordMatch.found.map(k => `<span class="badge success">${sanitizeHTML(k)}</span>`).join(' ');
    const missingHTML = keywordMatch.missing.slice(0, 40).map(k => `<span class="badge">${sanitizeHTML(k)}</span>`).join(' ');

    const sectionChecklist = [
        { key: 'summary', label: 'Summary' },
        { key: 'skills', label: 'Skills' },
        { key: 'experience', label: 'Experience' },
        { key: 'education', label: 'Education' },
        { key: 'projects', label: 'Projects' },
        { key: 'certifications', label: 'Certifications' }
    ].map(s => {
        const present = !!sections[s.key];
        return `<li class="check-item ${present ? 'ok' : 'miss'}">${present ? '✔' : '✖'} ${s.label}</li>`;
    }).join('');

    const extractedHTML = ['summary','skills','experience','education','projects','certifications']
        .filter(k => sections[k])
        .map(k => `
            <div class="extracted">
                <h4>${k.charAt(0).toUpperCase() + k.slice(1)}</h4>
                <div class="mono">${nl2br(sections[k])}</div>
            </div>
        `).join('');

    const contactRows = Object.entries(contact).filter(([,v]) => !!v).map(([k,v]) => `
        <div class="kv"><span class="k">${k}:</span><span class="v">${sanitizeHTML(v)}</span></div>
    `).join('') || '<div class="muted">No contact details detected.</div>';

    const suggestions = generateSuggestions(components);
    const suggestionsHTML = suggestions.length ? `<ul class="suggestions">${suggestions.map(s => `<li>${sanitizeHTML(s)}</li>`).join('')}</ul>` : '<div class="muted">No suggestions. Great job!</div>';

    const overviewHTML = `
        <div class="overview">
            <div class="score">
                <div class="score-value">${score}</div>
                <div class="score-label">${sanitizeHTML(label)}</div>
            </div>
            <div class="score-meta">
                <div class="kv"><span class="k">Keyword coverage:</span><span class="v">${Math.round(coverage * 100)}%</span></div>
                <div class="kv"><span class="k">Word count:</span><span class="v">${stats.wordCount}</span></div>
                <div class="kv"><span class="k">Estimated pages:</span><span class="v">${stats.estimatedPages}</span></div>
                <div class="kv"><span class="k">Reading time:</span><span class="v">~${stats.readingTimeMin} min</span></div>
                <div class="kv"><span class="k">Bullets:</span><span class="v">${stats.bulletLines}</span></div>
                <div class="kv"><span class="k">Links/Emails/Phones:</span><span class="v">${stats.links}/${stats.emails}/${stats.phones}</span></div>
            </div>
        </div>
    `;

    const html = `
        <h2>ATS Analysis Report</h2>
        ${overviewHTML}
        <div class="grid">
            <section>
                <h3>Keyword Coverage</h3>
                <div class="section">
                    <div class="kv"><span class="k">Total keywords:</span><span class="v">${keywords.length}</span></div>
                    <div class="kv"><span class="k">Found (${keywordMatch.found.length}):</span><span class="v">${foundHTML || '<span class="muted">None</span>'}</span></div>
                    <div class="kv"><span class="k">Missing (${keywordMatch.missing.length}):</span><span class="v">${missingHTML || '<span class="muted">None</span>'}</span></div>
                </div>
            </section>
            <section>
                <h3>Structure Check</h3>
                <ul class="checklist">${sectionChecklist}</ul>
                <h3>Contact Details</h3>
                <div class="section">${contactRows}</div>
            </section>
        </div>

        <section>
            <h3>Actionable Suggestions</h3>
            ${suggestionsHTML}
        </section>

        <section>
            <h3>Extracted Sections (Preview)</h3>
            ${extractedHTML || '<div class="muted">No recognizable sections extracted. Consider adding clear headings like "Experience", "Education", and "Skills".</div>'}
        </section>

        <details class="raw">
            <summary>Show normalized resume text</summary>
            <div class="mono">${nl2br(rawText)}</div>
        </details>
    `;

    els.report.innerHTML = html;
    els.exportActions.hidden = false;
}

function buildExportHTML() {
    // Build a minimal standalone HTML export including inline styles for portability
    const content = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ATS Analysis Report</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;margin:24px;background:#fff;color:#222}
h1,h2,h3{color:#222} .badge{display:inline-block;padding:2px 8px;border-radius:10px;background:#eee;margin:2px} .badge.success{background:#d3f9d8}
.kv{display:flex;gap:8px;margin:2px 0}.k{color:#555;min-width:160px;font-weight:bold}.v{color:#111}
.checklist{list-style:none;padding:0;margin:0}.check-item{margin:4px 0}.check-item.ok{color:#065f46}.check-item.miss{color:#b91c1c}
.overview{display:flex;gap:24px;align-items:center;margin:12px 0 16px}.score{width:120px;height:120px;border-radius:60px;background:#f5f6fa;display:flex;flex-direction:column;align-items:center;justify-content:center}
.score-value{font-size:32px;font-weight:bold}.score-label{font-size:12px;color:#555;text-transform:uppercase;letter-spacing:1px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}
.section{margin:8px 0}.mono{white-space:pre-wrap;font-family:ui-monospace,Consolas,Menlo,monospace;background:#fafafa;border:1px solid #eee;border-radius:6px;padding:8px}
.muted{color:#6b7280}
@media print{.raw{display:none}}
</style>
</head>
<body>
<h1>ATS Analysis Report</h1>
${els.report.innerHTML}
</body>
</html>`;
    return content;
}

// ---------- Main flow ----------
async function extractResumeText(file) {
    const kind = detectFileKind(file);
    if (kind === 'txt') return await readFileAsText(file);
    if (kind === 'pdf') return await parsePDF(file);
    if (kind === 'docx') return await parseDOCX(file);
    if (kind === 'doc') throw new Error('.doc format is not supported. Please convert to .docx or PDF.');
    throw new Error('Unsupported file type. Please upload a PDF, DOCX, or TXT file.');
}

async function handleAnalyze(sampleText) {
    try {
        setBusy(true);
        let resumeText = '';
        if (sampleText) {
            resumeText = sampleText;
        } else {
            if (!currentFile) throw new Error('Please upload a resume file.');
            if (currentFile.size > 8 * 1024 * 1024) throw new Error('File too large. Please upload a file under 8 MB.');
            resumeText = await extractResumeText(currentFile);
        }

        const jd = els.jobDescription.value || '';
        const customKw = (els.customKeywords.value || '').split(',').map(s => s.trim()).filter(Boolean);

        const rawText = normalizeText(resumeText);
        const sections = extractSections(rawText);
        const stats = computeStats(rawText);
        const contact = { ...sections.contact };
        const keywords = extractKeywordsFromJD(jd, customKw);
        const keywordMatch = matchKeywords(rawText, keywords);
        const { score, label, coverage } = computeScore({ sections, keywordMatch, stats, contact });

        const components = { sections, stats, contact, keywords, keywordMatch, score, label, coverage, rawText };
        renderReport(components);
    } catch (err) {
        console.error(err);
        els.report.innerHTML = `<div class="alert error">${sanitizeHTML(err.message || 'Analysis failed.')}</div>`;
        els.exportActions.hidden = true;
    } finally {
        setBusy(false);
    }
}

// ---------- Events ----------
els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    handleAnalyze();
});

attachDropzone();
attachFileInput();

els.downloadReport?.addEventListener('click', () => {
    const html = buildExportHTML();
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'ats-report.html';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
});

// ---------- AI Integration ----------
function getAIConfig() {
    // AI Settings section removed; use server defaults
    return { enabled: true, provider: 'openai', model: 'gpt-4o-mini' };
}

function setAIStatus(msg, isError = false) {
    // AI status UI removed; no-op
}

async function callAI({ system, prompt }) {
    const cfg = getAIConfig();
    if (!cfg.enabled) throw new Error('Enable AI-based analysis in AI Settings.');

    const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: cfg.provider, model: cfg.model, system, prompt })
    });
    if (!res.ok) {
        let msg = `${res.status} ${res.statusText}`;
        try { const j = await res.json(); msg = j.error || msg; } catch {}
        throw new Error(`AI request failed: ${msg}`);
    }
    const data = await res.json();
    if (!data.text) throw new Error('AI response was empty.');
    return data.text;
}

function buildAIPromptForSummary({ rawText, jobDescription, found, missing }) {
    return `You are an expert resume coach. Given the resume text and job description, write a concise professional summary (4-6 sentences) tailored to the role. Optimize for ATS by naturally including relevant keywords. Avoid personal pronouns and keep it straightforward.

RESUME TEXT:\n${rawText}\n\nJOB DESCRIPTION:\n${jobDescription}\n\nFOUND KEYWORDS:\n${found.join(', ')}\n\nMISSING BUT IMPORTANT KEYWORDS (try to include if appropriate):\n${missing.slice(0, 15).join(', ')}\n`;
}

function buildAIPromptForBullets({ rawText, jobDescription, found, missing }) {
    return `You are an expert resume writer. Create 6-10 bullet points of quantified achievements tailored to the job description. Each bullet should:
- Start with a strong action verb;
- Include a measurable outcome (%, $, time, volume) when possible;
- Naturally include relevant keywords without keyword stuffing;
- Be succinct (max ~22 words per bullet).

Output bullets as a simple \"- \" list, nothing else.

RESUME TEXT:\n${rawText}\n\nJOB DESCRIPTION:\n${jobDescription}\n\nKEYWORDS TO FAVOR:\n${found.concat(missing.slice(0, 10)).join(', ')}\n`;
}

async function aiGenerate(kind) {
    try {
        setBusy(true);
        setAIStatus('Contacting AI…');
        const jd = els.jobDescription.value || '';
        const reportRoot = els.report;
        const rawText = reportRoot?.querySelector('.raw .mono')?.innerText || '';
        if (!rawText) throw new Error('Run the standard analysis first to extract the resume text.');

        const found = Array.from(reportRoot.querySelectorAll('.badge.success')).map(b => b.textContent.trim());
        const missing = Array.from(reportRoot.querySelectorAll('.badge:not(.success)')).map(b => b.textContent.trim());

        let prompt;
        if (kind === 'summary') {
            prompt = buildAIPromptForSummary({ rawText, jobDescription: jd, found, missing });
        } else {
            prompt = buildAIPromptForBullets({ rawText, jobDescription: jd, found, missing });
        }

        const system = 'You write ATS-friendly resume content. Keep outputs concise, factual, and aligned to the job description.';
        const out = await callAI({ system, prompt });

        const containerId = kind === 'summary' ? 'ai-summary' : 'ai-bullets';
        let container = document.getElementById(containerId);
        if (!container) {
            container = document.createElement('section');
            container.id = containerId;
            container.innerHTML = `<h3>${kind === 'summary' ? 'AI Tailored Summary' : 'AI Keyword-Rich Bullets'}</h3><div class="mono"></div>`;
            els.report.appendChild(container);
        }
        const mono = container.querySelector('.mono');
        mono.innerHTML = nl2br(out);
        setAIStatus('AI content generated successfully.');
    } catch (err) {
        console.error(err);
        setAIStatus(err.message || 'AI generation failed.', true);
    } finally {
        setBusy(false);
    }
}

els.aiGenerateSummary?.addEventListener('click', () => aiGenerate('summary'));
els.aiGenerateBullets?.addEventListener('click', () => aiGenerate('bullets'));

els.printReport?.addEventListener('click', () => window.print());

els.resetForm?.addEventListener('click', () => {
    els.form.reset();
    currentFile = null;
    els.fileInfo.textContent = '';
    els.report.innerHTML = `
        <div class="placeholder">
            <div class="placeholder-title">Your report will appear here</div>
            <div class="placeholder-text">Upload a resume and add a job description to generate a comprehensive ATS analysis.</div>
        </div>
    `;
    els.exportActions.hidden = true;
});

// ---------- Sample Data ----------
const SAMPLE_RESUME = `
John Doe\njohn.doe@example.com | +1 (555) 123-4567 | linkedin.com/in/johndoe | github.com/johndoe\n\nSummary\nFull-stack developer with 6+ years of experience building scalable web applications. Led cross-functional teams and delivered high-impact features.\n\nSkills\nJavaScript, TypeScript, React, Node.js, Express, GraphQL, REST, PostgreSQL, MongoDB, Docker, AWS, CI/CD, Git\n\nExperience\nSenior Software Engineer, Acme Corp — Jan 2021 – Present\n- Led migration to microservices, improving deployment frequency by 40%.\n- Designed and implemented GraphQL gateway; reduced API latency by 25%.\n- Optimized PostgreSQL queries, reducing costs by 15%.\n\nSoftware Engineer, Beta Inc — Jul 2018 – Dec 2020\n- Built React component library; improved developer velocity by 30%.\n- Implemented CI/CD pipeline with Jenkins and Docker.\n\nEducation\nB.S. in Computer Science, University of Example — 2018\n\nProjects\nRealtime chat app with WebSocket and Redis pub/sub.\n\nCertifications\nAWS Certified Developer – Associate\n`;

const SAMPLE_JD = `
We are seeking a Senior Full-Stack Engineer proficient in JavaScript/TypeScript, React, Node.js, and AWS. Experience with microservices, REST/GraphQL APIs, PostgreSQL, CI/CD, Docker, and Kubernetes is required. Nice to have: Redis, MongoDB, Terraform. Strong communication skills and the ability to deliver high-quality software in an agile environment.\n`;

els.useSampleResume?.addEventListener('click', () => {
    currentFile = null; // Ensure we don't parse a real file
    showFileInfo({ name: 'Sample_Resume.txt', size: SAMPLE_RESUME.length });
    handleAnalyze(SAMPLE_RESUME);
});

els.useSampleJD?.addEventListener('click', () => {
    els.jobDescription.value = SAMPLE_JD;
});

// Accessibility: analyze when JD is pasted/changed and a sample resume loaded
els.jobDescription.addEventListener('input', debounce(() => {
    // If we already loaded sample resume and there's a JD, re-analyze
    if (!currentFile && els.fileInfo.textContent.includes('Sample_Resume') && els.jobDescription.value.trim()) {
        handleAnalyze(SAMPLE_RESUME);
    }
}, 800));
