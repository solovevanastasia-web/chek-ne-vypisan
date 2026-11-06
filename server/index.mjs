import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { CRITERIA, PublicError, validatePitch, nextQuestion, makeReport } from './engine.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
try { process.loadEnvFile(path.join(root, 'env/.env')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const sessions = new Map(), limits = new Map();
const TTL = 2 * 60 * 60 * 1000;
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.pdf': 'application/pdf' };
function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}
function sessionFrom(req) {
  const token = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('investor_session='))?.slice(17);
  const s = sessions.get(token);
  if (s && Date.now() - s.touched < TTL) { s.touched = Date.now(); return s; }
  if (token) sessions.delete(token);
  return null;
}
function view(s) {
  if (!s) return { session: null };
  return { session: { id: s.id, pitch: s.pitch, days: s.days, question: s.question, answers: s.answers, report: s.report, step: s.answers.length + 1, completed: !!s.report, started: s.started } };
}
async function body(req) {
  let size = 0, chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 50000) throw new PublicError(413, 'Слишком большой запрос. Сократи текст.'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new PublicError(400, 'Не удалось прочитать запрос. Обнови страницу.'); }
}
function rateLimit(req, route) {
  // Trust forwarded IP only behind a configured reverse proxy.
  const ip = process.env.TRUST_PROXY === '1' ? (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.socket.remoteAddress : req.socket.remoteAddress;
  const key = `${ip}:${route}`, now = Date.now(), limit = route === '/api/start' ? 10 : 45;
  let entry = limits.get(key);
  if (!entry || now - entry.time > 60000) { entry = { time: now, count: 0 }; limits.set(key, entry); }
  if (++entry.count > limit) throw new PublicError(429, 'Слишком много запросов. Подожди минуту.');
}
export const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) throw new PublicError(403, 'Этот запрос пришёл с другого сайта.');
        if (!req.headers['content-type']?.startsWith('application/json')) throw new PublicError(415, 'Нужен JSON-запрос.');
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, configured: !!(process.env.GROQ_API_KEY || process.env.LLM_API_KEY) });
      if (req.method === 'GET' && url.pathname === '/api/session') return send(res, 200, view(sessionFrom(req)));
      if (req.method === 'GET' && url.pathname === '/api/rubric') return send(res, 200, { criteria: CRITERIA });
      if (req.method === 'POST' && url.pathname === '/api/start') {
        rateLimit(req, url.pathname);
        if (sessions.size >= 300) throw new PublicError(503, 'Сейчас много тренировок. Попробуй чуть позже.');
        const data = await body(req), pitch = validatePitch(data.pitch);
        const existing = sessionFrom(req);
        if (existing?.busy) throw new PublicError(409, 'Дождись ответа инвестора.');
        const s = { id: randomBytes(24).toString('hex'), pitch, days: Math.min(30, Math.max(1, Math.round(Number(data.days) || 2))), answers: [], question: null, report: null, started: Date.now(), touched: Date.now(), busy: true, lastRequest: null };
        s.question = await nextQuestion(s);
        if (!s.question.valid) return send(res, 422, { error: s.question.reason });
        s.busy = false;
        if (existing) sessions.delete(existing.id);
        sessions.set(s.id, s);
        const secure = req.socket.encrypted || (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-proto'] === 'https');
        return send(res, 200, view(s), { 'Set-Cookie': `investor_session=${s.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=7200${secure ? '; Secure' : ''}` });
      }
      if (req.method === 'POST' && url.pathname === '/api/answer') {
        rateLimit(req, url.pathname);
        const s = sessionFrom(req);
        if (!s) throw new PublicError(401, 'Тренировка истекла или сервер перезапустился. Начни новый раунд.');
        const data = await body(req);
        if (s.busy) throw new PublicError(409, 'Инвестор ещё готовит ответ. Подожди немного.');
        if (data.requestId && data.requestId === s.lastRequest) return send(res, 200, view(s));
        if (s.report || s.answers.length >= 5) throw new PublicError(409, 'Раунд завершён. Все пять ответов уже учтены.');
        if (data.step !== s.answers.length + 1) throw new PublicError(409, 'Этот ответ относится к предыдущему шагу. Обнови страницу.');
        if (typeof data.answer !== 'string' || !data.answer.trim() || data.answer.length > 2000) throw new PublicError(400, 'Напиши ответ до 2 000 символов или выбери «Не знаю».');
        s.busy = true;
        const next = { ...s, answers: [...s.answers, { question: s.question, answer: data.answer.trim() }] };
        try {
          if (next.answers.length === 5) { next.report = await makeReport(next); next.question = null; }
          else next.question = await nextQuestion(next);
          s.answers = next.answers; s.question = next.question; s.report = next.report; s.lastRequest = data.requestId;
        } finally { s.busy = false; }
        return send(res, 200, view(s));
      }
      if (req.method === 'POST' && url.pathname === '/api/delete') {
        const s = sessionFrom(req); if (s) sessions.delete(s.id);
        return send(res, 200, { ok: true }, { 'Set-Cookie': 'investor_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      }
      return send(res, 404, { error: 'Такого действия нет.' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Метод не поддерживается.' });
    const filePath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    if (filePath.includes('..') || filePath.includes('\\') || filePath.split('/').some(s => s.startsWith('.'))) return send(res, 404, { error: 'Не найдено.' });
    const target = path.join(root, 'public', filePath);
    let buffer;
    try { buffer = await readFile(target); } catch { return send(res, 404, { error: 'Не найдено.' }); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : buffer);
  } catch (e) {
    if (!(e instanceof PublicError)) console.error('request_failed', e.name, ['question_schema','report_schema','advice_schema','duplicate_question'].includes(e.message) ? e.message : 'upstream_or_internal');
    send(res, e.status || 502, { error: e instanceof PublicError ? e.message : 'Инвестор не успел подготовить ответ. Повтори запрос — текущий шаг сохранён.' });
  }
});
const gc = setInterval(() => { const now = Date.now(); for (const [id, s] of sessions) if (now - s.touched > TTL) sessions.delete(id); for (const [id, e] of limits) if (now - e.time > 120000) limits.delete(id); }, 60000);
gc.unref();
if (process.env.NODE_ENV !== 'test') {
  const port = Number(process.env.PORT || 3000);
  server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Чек не выписан: http://localhost:${port}`));
}
