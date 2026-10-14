#!/usr/bin/env node
// MCP para publicar historias de Instagram desde Meta Business Suite, con la
// sesión de cualquier cuenta de Facebook y para cualquier página con una
// cuenta de Instagram vinculada.
//
// Replica lo que hace el composer de historias de Business Suite (capturado el
// 2026-10-09): sube la foto a
// upload-business.facebook.com/ajax/react_composer/attachments/photo/upload
// y publica con la mutation BusinessComposerStoryCreationMutation de /api/graphql/.
// Para programar, la misma mutation lleva unpublished_content_data
// ({ scheduled_publish_time, unpublished_content_type: 'SCHEDULED' }) en base,
// FACEBOOK_STORY e INSTAGRAM_STORY (leído del módulo
// BusinessStoriesComposerMutationUtils el 2026-10-10). Los "momentos de más
// actividad" salen de BusinessComposerScheduleTimeRecommendationsQuery.
// Video (capturado el 2026-10-14): start en
// vupload-edge-business.facebook.com/ajax/video/upload/requests/start/ (da
// video_id y upload_session_id), los bytes en un POST a
// rupload.facebook.com/fb_video/<clave>-0-<tamaño>, el handle que devuelve en
// .../requests/receive/, después BusinessComposerVideoEncodingTriggerMutation,
// BusinessComposerMediaUploadUtilsVideoStatusQuery hasta OK y
// BusinessComposerVideoSetUndiscoverableMutation. La mutation de la historia es
// la misma, con { video: { id } } en vez de { photo: { id } }.
// Las llamadas salen desde una página de Business Suite abierta con un perfil
// de Brave propio, así usan la sesión y los tokens de esa página.
//
// Datos en ~/.local/share/ig-mcp (o IG_MCP_HOME):
//   profiles/<perfil>/   un perfil de navegador por cuenta de Facebook
//   accounts.json        cuentas de Instagram confirmadas: página, portfolio y perfil

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { chromium } from 'playwright-core';
import { z } from 'zod';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';

const HOME = process.env.IG_MCP_HOME ?? join(homedir(), '.local/share/ig-mcp');
const ACCOUNTS = join(HOME, 'accounts.json');
const BROWSER = process.env.IG_MCP_BROWSER ?? '/usr/bin/brave';
const HEADLESS = process.env.IG_MCP_HEADLESS !== '0';

// doc_id de la mutation al capturarla. Meta lo rota con cada deploy: primero se
// busca el vigente en los módulos de la página y este queda de respaldo.
const DOC_ID_FALLBACK = process.env.IG_MCP_DOC_ID ?? '9453776261410796';
const BEST_TIMES_DOC_ID_FALLBACK = '9893940570694200';
const VIDEO_DOC_IDS = {
  BusinessComposerVideoEncodingTriggerMutation: '24270092939258127',
  BusinessComposerMediaUploadUtilsVideoStatusQuery: '29954615157462710',
  BusinessComposerVideoSetUndiscoverableMutation: '9931897063525095',
};

const BS = 'https://business.facebook.com/latest/';
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4', '.mov': 'video/quicktime' };

// IG_MCP_ACCOUNT fija la cuenta del proyecto (ver README).
const PINNED = process.env.IG_MCP_ACCOUNT?.replace(/^@/, '') || null;

const composerUrl = ({ pageId, businessId }) =>
  `${BS}story_composer/?asset_id=${pageId}${businessId ? `&business_id=${businessId}` : ''}`;

// Un perfil persistente no se puede abrir dos veces: las tools van en fila.
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

async function loadAccounts() {
  try { return JSON.parse(await readFile(ACCOUNTS, 'utf8')); } catch { return {}; }
}

async function saveAccount(account) {
  const all = await loadAccounts();
  all[account.username] = account;
  await mkdir(HOME, { recursive: true, mode: 0o700 });
  await writeFile(ACCOUNTS, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
}

async function openProfile(profile, headless) {
  const dir = join(HOME, 'profiles', profile);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return chromium.launchPersistentContext(dir, {
    executablePath: BROWSER,
    headless,
    viewport: headless ? { width: 1440, height: 900 } : null,
    locale: 'es-AR',
  });
}

// Solo mira si las cookies de sesión existen; nunca devuelve sus valores.
async function sessionInfo(context) {
  const cookies = await context.cookies('https://business.facebook.com');
  const xs = cookies.find((c) => c.name === 'xs');
  const user = cookies.find((c) => c.name === 'c_user');
  return {
    loggedIn: Boolean(xs && user),
    userId: user?.value ?? null,
    expires: xs?.expires > 0 ? new Date(xs.expires * 1000).toISOString().slice(0, 10) : null,
  };
}

// El composer de una página trae embebidas la página y su cuenta de Instagram:
// {"__typename":"Page","accountName":…,"id":…,"presenceType":"FACEBOOK",…}
// {"__typename":"XFBShadowIGMediaCreatorAccount","accountName":…,"id":…,"presenceType":"INSTAGRAM",…}
function presencesIn(html, pageId) {
  let pageName = null;
  const ig = new Map();
  for (const [raw] of html.matchAll(/\{"__typename":"[A-Za-z]+","accountName":[^{}]*?"presenceType":"(?:FACEBOOK|INSTAGRAM)"[^{}]*\}/g)) {
    let o;
    try { o = JSON.parse(raw); } catch { continue; }
    if (o.presenceType === 'INSTAGRAM' && o.id) ig.set(o.id, { username: o.accountName, igId: o.id });
    if (o.presenceType === 'FACEBOOK' && o.id === pageId) pageName = o.accountName;
  }
  return { pageName, ig: [...ig.values()] };
}

async function openComposer(page, asset) {
  await page.goto(composerUrl(asset), { waitUntil: 'domcontentloaded' });
  if (!page.url().startsWith(BS)) return null;
  await page.waitForFunction(() => {
    try { return Boolean(window.require('DTSGInitialData').token); } catch { return false; }
  }, null, { timeout: 30_000 }).catch(() => {});
  await page.waitForFunction(() => document.documentElement.innerHTML.includes('"presenceType":"INSTAGRAM"'), null, { timeout: 10_000 }).catch(() => {});
  return presencesIn(await page.content(), asset.pageId);
}

// Recuadro flotante que se inyecta en cada página de la ventana de login.
// Muestra qué página y qué cuenta de Instagram se guardarían con lo que está
// abierto ahora. Sin cuenta fijada, se guarda cuando el usuario aprieta
// Confirmar; con IG_MCP_ACCOUNT no hay botón y se guarda sola al detectarla.
function confirmWidget(withButton) {
  if (window.top !== window) return;
  const mount = () => {
    if (document.getElementById('ig-mcp-confirm')) return;
    const host = document.createElement('div');
    host.id = 'ig-mcp-confirm';
    host.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:2147483647';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      .box { font: 500 14px/1.45 system-ui, sans-serif; background: #111418; color: #f5f6f7;
             border: 1px solid #3a7bfd; border-radius: 14px; padding: 14px 16px; max-width: 300px;
             box-shadow: 0 10px 30px rgba(0,0,0,.4); }
      p { margin: 0 0 12px; white-space: pre-line; }
      button { all: unset; cursor: pointer; background: #3a7bfd; color: #fff; font-weight: 700;
               padding: 9px 18px; border-radius: 999px; }
      button[disabled] { opacity: .5; cursor: wait; }
    </style>
    <div class="box">
      <p id="msg">Cargando…</p>
      ${withButton ? '<button id="ok" disabled>Confirmar</button>' : ''}
    </div>`;
    if (withButton) root.getElementById('ok').onclick = () => window.__igMcpConfirm();
    document.documentElement.appendChild(host);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
  setInterval(mount, 1000);
}

async function setWidget(page, message, disabled) {
  await page.evaluate(([m, d]) => {
    const root = document.getElementById('ig-mcp-confirm')?.shadowRoot;
    if (!root) return;
    if (root.getElementById('msg').textContent !== m) root.getElementById('msg').textContent = m;
    const ok = root.getElementById('ok');
    if (ok) ok.disabled = d;
  }, [message, disabled]).catch(() => {});
}

const assetOf = (page) => {
  try {
    const url = new URL(page.url());
    return url.href.startsWith(BS) && url.searchParams.get('asset_id')
      ? { pageId: url.searchParams.get('asset_id'), businessId: url.searchParams.get('business_id') }
      : null;
  } catch { return null; }
};

// Lee qué cuenta de IG tiene la página en un navegador headless aparte, con la
// misma sesión copiada en memoria, para no tocar la ventana del usuario.
async function detectAccount(detector, context, asset, profile) {
  const ctx = await detector.newContext({ storageState: await context.storageState(), locale: 'es-AR' });
  try {
    const found = await openComposer(await ctx.newPage(), asset);
    if (!found) return { asset, msg: 'Esta cuenta de Facebook no puede crear historias en esa página.' };
    const name = found.pageName ?? asset.pageId;
    if (!found.ig.length) return { asset, msg: `La página "${name}" no tiene una cuenta de Instagram vinculada. Elegí otra en el selector de arriba a la izquierda.` };
    const account = { ...found.ig[0], pageName: found.pageName, ...asset, profile };
    if (PINNED && account.username !== PINNED) {
      return {
        asset,
        msg: `Este proyecto usa @${PINNED}, pero la página "${name}" publica en @${account.username}.\n\nElegí la página de @${PINNED} en el selector de arriba a la izquierda, o iniciá sesión con la cuenta de Facebook que la administra.`,
      };
    }
    return {
      asset,
      account,
      msg: PINNED
        ? `Cuenta correcta: @${account.username} (página "${name}"). Guardando…`
        : `Se va a guardar:\nPágina de Facebook: ${name}\nInstagram: @${account.username}\n\nSi no es esta, cambiá de página o de cuenta.`,
    };
  } finally {
    await ctx.close();
  }
}

async function authenticate({ profile, timeout_min }) {
  const context = await openProfile(profile, false);
  const detector = await chromium.launch({ executablePath: BROWSER, headless: true });
  let confirmedOn = null;
  let closed = false;
  context.on('close', () => { closed = true; });
  await context.exposeBinding('__igMcpConfirm', ({ page }) => { confirmedOn = page; });
  await context.addInitScript(confirmWidget, !PINNED);
  try {
    // Si la cuenta fijada ya se guardó antes, se abre directo en su página.
    const known = PINNED && (await loadAccounts())[PINNED];
    const first = context.pages()[0] ?? (await context.newPage());
    await first.goto(known ? `${BS}home?asset_id=${known.pageId}${known.businessId ? `&business_id=${known.businessId}` : ''}` : `${BS}home`);
    const deadline = Date.now() + timeout_min * 60_000;
    let state = { msg: 'Cargando…' };
    const render = (s) => Promise.all(context.pages().map((p) => setWidget(p, s.msg, !s.account)));

    while (!closed && Date.now() < deadline) {
      // Con cuenta fijada se guarda apenas se detecta; sin ella, al confirmar.
      const page = PINNED ? (state.account && first) : confirmedOn;
      confirmedOn = null;
      if (page) {
        if (state.account && (PINNED || assetOf(page)?.pageId === state.account.pageId)) {
          const account = { ...state.account, savedAt: new Date().toISOString().slice(0, 10) };
          await saveAccount(account);
          await render({ msg: `Guardada @${account.username}. La ventana se cierra sola.` });
          await new Promise((r) => setTimeout(r, 1500));
          const { expires } = await sessionInfo(context);
          return text(`Cuenta confirmada: @${account.username} (página "${account.pageName ?? account.pageId}", perfil "${profile}"${expires ? `, sesión vence ${expires}` : ''}).`);
        }
      }

      const active = context.pages().filter(assetOf).at(-1);
      const asset = active && assetOf(active);
      const session = await sessionInfo(context);
      if (!session.loggedIn) {
        state = { msg: PINNED
          ? `Iniciá sesión en Facebook con la cuenta que administra @${PINNED}.`
          : 'Iniciá sesión en Facebook con la cuenta que administra la página.' };
      } else if (!asset) {
        state = { msg: PINNED
          ? `Abrí Meta Business Suite y elegí la página de @${PINNED}.`
          : 'Abrí Meta Business Suite y elegí la página cuya cuenta de Instagram vas a usar.' };
      } else if (asset.pageId !== state.asset?.pageId || session.userId !== state.userId) {
        await render({ msg: 'Buscando la cuenta de Instagram de esta página…' });
        state = { ...(await detectAccount(detector, context, asset, profile)), userId: session.userId };
      }
      await render(state);
      await new Promise((r) => setTimeout(r, 1000));
    }
    const what = PINNED ? `la cuenta @${PINNED}` : 'ninguna cuenta';
    return fail(closed ? `Se cerró la ventana sin guardar ${what}.` : `No se guardó ${what} en ${timeout_min} min.`);
  } finally {
    await detector.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

async function listAccounts() {
  const accounts = Object.values(await loadAccounts());
  if (!accounts.length) return text('No hay cuentas guardadas: correr authenticate.');
  const sessions = {};
  for (const profile of new Set(accounts.map((a) => a.profile))) {
    const context = await openProfile(profile, true);
    try { sessions[profile] = await sessionInfo(context); } finally { await context.close(); }
  }
  return text(accounts.map((a) => {
    const s = sessions[a.profile];
    const state = s.loggedIn ? `sesión ok${s.expires ? `, vence ${s.expires}` : ''}` : 'sin sesión: correr authenticate';
    return `@${a.username} · página ${a.pageId} · perfil "${a.profile}" · ${state}`;
  }).join('\n'));
}

// Se instala en la página de Business Suite antes de las llamadas: arma los
// parámetros de sesión y hace los POST a /api/graphql/. Los tokens se leen en
// el momento y no salen de la página.
function installPageHelpers() {
  const req = window.require;
  const common = (pageId) => {
    const dtsg = req('DTSGInitialData').token;
    let lsd = '';
    try { lsd = req('LSD').token; } catch {}
    let sum = 0;
    for (const ch of dtsg) sum += ch.charCodeAt(0);
    let asyncParams = {};
    try { asyncParams = req('getAsyncParams')('POST'); } catch {}
    const userId = req('CurrentUserInitialData').USER_ID;
    return { ...asyncParams, av: pageId, __user: userId, __a: '1', fb_dtsg: dtsg, jazoest: `2${sum}`, lsd };
  };
  const graphql = async (pageId, name, docIdFallback, variables) => {
    let docId = docIdFallback;
    try { docId = String(req(`${name}_facebookRelayOperation`) || docIdFallback); } catch {}
    const params = common(pageId);
    const res = await fetch('/api/graphql/', {
      method: 'POST',
      body: new URLSearchParams({
        ...params,
        fb_api_caller_class: 'RelayModern',
        fb_api_req_friendly_name: name,
        server_timestamps: 'true',
        variables: JSON.stringify(variables),
        doc_id: docId,
      }),
      credentials: 'include',
      headers: { 'X-FB-Friendly-Name': name, 'X-FB-LSD': params.lsd },
    });
    const resText = await res.text();
    let json = {};
    try { json = JSON.parse(resText.split('\n')[0]); } catch {}
    return { docId, status: res.status, data: json.data, error: json.errors?.[0]?.message ?? resText.slice(0, 200) };
  };
  window.__igMcp = { common, graphql };
}

// Corre dentro de la página de Business Suite: sube la foto o el video y
// publica (o programa, si viene scheduleAt en segundos unix).
async function publishInPage({ b64, name, mime, pageId, igId, docIdFallback, videoDocIds, alsoFacebook, scheduleAt, dryRun }) {
  const common = window.__igMcp.common(pageId);
  const userId = common.__user;
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const isVideo = mime.startsWith('video/');

  // 1. Subida
  let media, original, mediaId;
  if (isVideo) {
    const v = await window.__igMcpUpload.uploadVideo(bytes, name, pageId, common, videoDocIds);
    if (v.error) return v;
    mediaId = v.videoId;
    media = { video: { id: mediaId, story_call_to_action_data: null, overlays: [] } };
    original = [];
  } else {
    const p = await window.__igMcpUpload.uploadPhoto(bytes, name, mime, userId, common);
    if (p.error) return p;
    mediaId = p.photoId;
    media = { photo: { id: mediaId, story_call_to_action_data: null, overlays: [] } };
    original = [{ original_photo_id: mediaId, burned_photo: { story_call_to_action_data: null, id: mediaId, overlays: [] } }];
  }
  if (dryRun) return { mediaId, isVideo, dryRun: true };

  // 2. Publicación
  const scheduled = scheduleAt ? { scheduled_publish_time: scheduleAt, unpublished_content_type: 'SCHEDULED' } : null;
  const perChannel = scheduled ? { unpublished_content_data: scheduled } : {};
  const variables = {
    input: {
      client_mutation_id: '1',
      base: {
        actor_id: pageId,
        composer_entry_point: 'biz_web_home_stories',
        source: 'WWW',
        unpublished_content_data: scheduled,
        attachments: [media],
        story_original_attachments_data: original,
      },
      channels: alsoFacebook ? ['FACEBOOK_STORY', 'INSTAGRAM_STORY'] : ['INSTAGRAM_STORY'],
      identities: [pageId, igId],
      FACEBOOK_STORY: { geo_gating: null, attachments: [media], ...perChannel },
      INSTAGRAM_STORY: { targeted_privacy_data: null, attachments: [media], ...perChannel },
      logging: { composer_session_id: crypto.randomUUID() },
    },
    checkPhotosToReelsUpsellEligibility: false,
  };
  const r = await window.__igMcp.graphql(pageId, 'BusinessComposerStoryCreationMutation', docIdFallback, variables);
  const created = r.data?.xfamily_content_create;
  if (!created) return { step: 'publish', mediaId, docId: r.docId, status: r.status, error: r.error };
  return { mediaId, isVideo, docId: r.docId, errors: created.errors };
}

// Las dos subidas corren en la página, como publishInPage; uploadStory las
// instala como window.__igMcpUpload antes de publicar.
async function uploadPhoto(bytes, name, mime, userId, common) {
  const form = new FormData();
  form.append('source', '8');
  form.append('profile_id', userId);
  form.append('waterfallxapp', 'comet');
  form.append('upload_id', String(1024 + Math.floor(Math.random() * 1000)));
  form.append('farr', new File([bytes], name, { type: mime }));
  const up = await fetch(
    'https://upload-business.facebook.com/ajax/react_composer/attachments/photo/upload?' + new URLSearchParams(common),
    { method: 'POST', body: form, credentials: 'include' },
  );
  const upText = (await up.text()).replace(/^for \(;;\);/, '');
  let upJson = {};
  try { upJson = JSON.parse(upText); } catch {}
  const photoId = upJson.payload?.photoID;
  if (!photoId) {
    return { step: 'upload', status: up.status, error: upJson.errorSummary ?? upJson.errorDescription ?? upText.slice(0, 200) };
  }
  return { photoId };
}

// start, los bytes a rupload, receive, encoding y espera a que Meta lo procese
async function uploadVideo(bytes, name, pageId, common, docIds) {
  const size = bytes.length;
  const ext = (name.split('.').pop() || 'mp4').toLowerCase();
  const waterfall = crypto.randomUUID().replace(/-/g, '');
  const vupload = 'https://vupload-edge-business.facebook.com/ajax/video/upload/requests/';
  const ajax = async (res) => {
    const t = (await res.text()).replace(/^for \(;;\);/, '');
    try { return { status: res.status, json: JSON.parse(t) }; } catch { return { status: res.status, json: {}, text: t.slice(0, 200) }; }
  };
  const why = (r) => r.json.errorSummary ?? r.json.errorDescription ?? r.text ?? JSON.stringify(r.json).slice(0, 200);
  const shared = {
    target_id: pageId, source: 'composer', composer_dialog_version: '', waterfall_id: waterfall,
    composer_entry_point_ref: 'unknown', composer_work_shared_draft_mode: '', has_file_been_replaced: 'false',
    supports_chunking: 'true', partition_start_offset: '0', partition_end_offset: String(size),
  };

  const start = await ajax(await fetch(vupload + 'start/?' + new URLSearchParams({ av: pageId, __a: '1' }), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', X_FB_VIDEO_WATERFALL_ID: waterfall },
    body: new URLSearchParams({
      ...common, ...shared, file_size: String(size), file_extension: ext, supports_file_api: 'true',
      creator_product: '2', spherical: 'false', video_publisher_action_source: '', dpr: '1',
    }),
  }));
  const videoId = start.json.payload?.video_id, sessionId = start.json.payload?.upload_session_id;
  if (!videoId) return { step: 'video start', status: start.status, error: why(start) };

  const key = `${crypto.randomUUID().replace(/-/g, '')}-0-${size}`;
  const up = await fetch(`https://rupload.facebook.com/fb_video/${key}?` + new URLSearchParams(common), {
    method: 'POST',
    credentials: 'include',
    headers: {
      'X-Entity-Name': 'undefined', 'X-Entity-Type': 'application/octet-stream', 'X-Entity-Length': String(size),
      Offset: '0', start_offset: '0', end_offset: String(size), composer_session_id: waterfall,
      id: String(sessionId), product_media_id: String(videoId), 'X-Total-Asset-Size': String(size),
    },
    body: new Blob([bytes], { type: 'application/octet-stream' }),
  });
  const upText = await up.text();
  let handle = null;
  try { handle = JSON.parse(upText).h; } catch {}
  if (!handle) return { step: 'video bytes', status: up.status, error: upText.slice(0, 200) };

  const form = new FormData();
  form.append('fbuploader_video_file_chunk', handle);
  const receive = await ajax(await fetch(vupload + 'receive/?' + new URLSearchParams({
    av: pageId, video_id: videoId, start_offset: '0', end_offset: String(size), ...shared, upload_speed: '', ...common,
  }), { method: 'POST', credentials: 'include', headers: { X_FB_VIDEO_WATERFALL_ID: waterfall }, body: form }));
  if (receive.json.payload?.start_offset !== size) return { step: 'video receive', status: receive.status, error: why(receive) };

  const gq = (op, variables) => window.__igMcp.graphql(pageId, op, docIds[op], variables);
  const enc = await gq('BusinessComposerVideoEncodingTriggerMutation', {
    input: { client_mutation_id: '1', video_id: videoId, actor_id: pageId, source: 'biz_composer' },
  });
  if (!enc.data?.video_encoding_trigger) return { step: 'video encoding', status: enc.status, error: enc.error };

  let state = null;
  for (let i = 0; i < 60 && state !== 'OK'; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await gq('BusinessComposerMediaUploadUtilsVideoStatusQuery', { video_id: videoId });
    state = st.data?.video?.video_status_type ?? state;
    if (state === 'ERROR') return { step: 'video encoding', status: st.status, error: 'Meta no pudo procesar el video' };
  }
  if (state !== 'OK') return { step: 'video encoding', status: 0, error: `el video sigue en ${state} después de 3 min` };

  const und = await gq('BusinessComposerVideoSetUndiscoverableMutation', { input: { client_mutation_id: '2', video_id: videoId } });
  if (!und.data?.video_set_undiscoverable) return { step: 'video undiscoverable', status: und.status, error: und.error };
  return { videoId };
}

// Corre dentro de la página de Business Suite: los "momentos de más actividad"
// que muestra el diálogo de programar, en segundos unix por canal.
async function bestTimesInPage({ pageId, igId, alsoFacebook, docIdFallback }) {
  const variables = {
    target_type: 'PAGE',
    target_id: pageId,
    params: {
      placement: 'COMPOSER_SCHEDULE_STORY',
      scheduling_config: alsoFacebook
        ? { identities: [pageId, igId], channels: ['FACEBOOK_STORY', 'INSTAGRAM_STORY'] }
        : { identities: [igId], channels: ['INSTAGRAM_STORY'] },
      logging_data: { session_id: crypto.randomUUID() },
    },
  };
  const r = await window.__igMcp.graphql(pageId, 'BusinessComposerScheduleTimeRecommendationsQuery', docIdFallback, variables);
  const byChannel = r.data?.unifiedInterception?.decision?.auxiliary_data?.hotspotsByChannel;
  if (!byChannel) return { docId: r.docId, status: r.status, error: r.error };
  return { hotspots: Object.fromEntries(byChannel.map((c) => [c.channel, c.hotspots.map(Number)])) };
}

// Devuelve la cuenta guardada a usar, o el mensaje de error.
async function pickAccount(account) {
  const accounts = await loadAccounts();
  const names = Object.keys(accounts);
  // La cuenta fijada es la que se usa por defecto y la única permitida, para no
  // publicar por error en la de otro proyecto.
  const asked = account?.replace(/^@/, '') || null;
  if (PINNED && asked && asked !== PINNED) return { error: `Este proyecto está fijado a @${PINNED} (IG_MCP_ACCOUNT); no publica en @${asked}.` };
  const wanted = asked ?? PINNED;
  const acc = wanted ? accounts[wanted] : names.length === 1 ? accounts[names[0]] : null;
  if (acc) return { acc };
  if (!names.length) return { error: 'No hay cuentas guardadas: correr authenticate.' };
  return { error: `${wanted ? `No hay una cuenta @${wanted} guardada.` : 'Hay varias cuentas: indicar account.'} Guardadas: ${names.map((n) => '@' + n).join(', ')}.` };
}

// Abre el composer de la cuenta y corre fn(page, igId) con los helpers ya
// instalados en la página.
async function withComposer(acc, fn) {
  const context = await openProfile(acc.profile, HEADLESS);
  try {
    if (!(await sessionInfo(context)).loggedIn) return fail(`El perfil "${acc.profile}" no tiene sesión: correr authenticate.`);
    const page = context.pages()[0] ?? (await context.newPage());
    const found = await openComposer(page, acc);
    if (!found) return fail('La sesión venció o Meta pidió verificar la cuenta: correr authenticate.');
    // El id de IG se toma fresco de la página: si la cuenta se desvinculó, no se publica.
    const current = found.ig.find((a) => a.username === acc.username);
    if (!current) return fail(`La página ${acc.pageId} ya no muestra @${acc.username} en Business Suite (ve: ${found.ig.map((a) => '@' + a.username).join(', ') || 'ninguna'}).`);
    await page.evaluate(installPageHelpers);
    return await fn(page, current.igId);
  } finally {
    await context.close();
  }
}

const localTime = (unix) => new Date(unix * 1000).toLocaleString('es-AR', {
  weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
});

// schedule_at acepta segundos unix o una fecha ISO 8601 (sin zona = hora local).
function parseSchedule(value) {
  const unix = /^\d+$/.test(value) ? Number(value) : Math.floor(Date.parse(value) / 1000);
  if (!Number.isFinite(unix)) return { error: `schedule_at inválido: "${value}". Usar segundos unix o ISO 8601 (2026-10-12T18:00-03:00).` };
  if (unix <= Date.now() / 1000 + 60) return { error: `schedule_at (${localTime(unix)}) ya pasó o es en menos de un minuto.` };
  return { unix };
}

async function uploadStory({ path, account, also_facebook, schedule_at, dry_run }) {
  const { acc, error } = await pickAccount(account);
  if (error) return fail(error);

  const schedule = schedule_at ? parseSchedule(schedule_at) : {};
  if (schedule.error) return fail(schedule.error);

  const file = resolve(path);
  const mime = MIME[extname(file).toLowerCase()];
  if (!mime) return fail(`Formato no soportado: ${extname(file)}. Usar .png, .jpg, .mp4 o .mov.`);
  const { size } = await stat(file);
  const max = mime.startsWith('video/') ? 100 : 30;
  if (size > max * 1024 * 1024) return fail(`El archivo pesa ${(size / 1e6).toFixed(1)} MB; el máximo es ${max} MB.`);
  const b64 = (await readFile(file)).toString('base64');

  return withComposer(acc, async (page, igId) => {
    await page.evaluate(`window.__igMcpUpload = { uploadPhoto: ${uploadPhoto}, uploadVideo: ${uploadVideo} }`);
    const r = await page.evaluate(publishInPage, {
      b64, name: basename(file), mime, pageId: acc.pageId, igId,
      docIdFallback: DOC_ID_FALLBACK, videoDocIds: VIDEO_DOC_IDS, alsoFacebook: also_facebook, scheduleAt: schedule.unix, dryRun: dry_run,
    });

    if (r.error) {
      const hint = r.step === 'publish' ? ` Si el doc_id (${r.docId}) quedó viejo, capturar el nuevo y pasarlo en IG_MCP_DOC_ID.` : '';
      return fail(`Falló el paso ${r.step} (HTTP ${r.status}): ${r.error}.${hint}`);
    }
    const kind = r.isVideo ? 'videoID' : 'photoID';
    if (r.dryRun) return text(`Dry run en @${acc.username}: ${r.isVideo ? 'video subido y procesado' : 'foto subida'} sin publicar (${kind} ${r.mediaId}). No se creó ninguna historia.`);

    const channels = also_facebook ? ['instagram_story', 'facebook_story'] : ['instagram_story'];
    const broken = Object.entries(r.errors ?? {}).filter(([k, v]) => v && channels.includes(k));
    if (broken.length) return fail(`Meta devolvió errores: ${JSON.stringify(Object.fromEntries(broken))}`);
    const where = `@${acc.username}${also_facebook ? ' y en su página de Facebook' : ''}`;
    const ids = `${kind} ${r.mediaId}, doc_id ${r.docId}`;
    return text(schedule.unix
      ? `Historia programada en ${where} para ${localTime(schedule.unix)} (${ids}). Se ve y se cancela en el Planificador de Business Suite.`
      : `Historia publicada en ${where} (${ids}). Puede tardar unos minutos en aparecer.`);
  });
}

async function bestTimes({ account, also_facebook }) {
  const { acc, error } = await pickAccount(account);
  if (error) return fail(error);
  return withComposer(acc, async (page, igId) => {
    const r = await page.evaluate(bestTimesInPage, {
      pageId: acc.pageId, igId, alsoFacebook: also_facebook, docIdFallback: BEST_TIMES_DOC_ID_FALLBACK,
    });
    if (r.error) return fail(`Meta no devolvió horarios (HTTP ${r.status}, doc_id ${r.docId}): ${r.error}`);
    const names = { INSTAGRAM_STORY: `Instagram @${acc.username}`, FACEBOOK_STORY: 'Página de Facebook' };
    return text(Object.entries(r.hotspots).map(([channel, times]) =>
      `${names[channel] ?? channel}:\n${times.map((t) => `- ${localTime(t)} · schedule_at ${t}`).join('\n')}`).join('\n\n'));
  });
}

const profileArg = z.string().regex(/^[\w-]+$/).default('default')
  .describe('Perfil de navegador = una cuenta de Facebook. Usar otro nombre para otra cuenta de Facebook');

const server = new McpServer({ name: 'ig-mcp', version: '0.1.0' });

server.registerTool('authenticate', {
  description: 'Abre Brave para iniciar sesión en Facebook y elegir en Meta Business Suite la página cuya cuenta de Instagram se va a usar. Un recuadro flotante muestra en vivo la página y la cuenta de IG detectadas. Si el proyecto fija IG_MCP_ACCOUNT, la ventana se cierra sola cuando detecta esa cuenta y no acepta otra; si no, el botón Confirmar guarda la que se ve. Correrla una vez por cuenta de Instagram, o cuando upload_story diga que la sesión venció.',
  inputSchema: {
    profile: profileArg,
    timeout_min: z.number().int().min(1).max(30).default(10).describe('Minutos para completar el login'),
  },
}, (args) => serial(() => authenticate(args)));

server.registerTool('list_accounts', {
  description: 'Lista las cuentas de Instagram guardadas, con su página, su perfil y si la sesión sigue activa. No devuelve cookies ni tokens.',
  inputSchema: {},
}, () => serial(listAccounts));

server.registerTool('upload_story', {
  description: 'Publica una imagen (.png o .jpg) o un video (.mp4 o .mov), idealmente 1080×1920, como historia de Instagram vía Meta Business Suite, ya o programada con schedule_at (ver best_times). El audio del video va tal cual; no admite sticker de link ni la música de Instagram. Publicar o programar es visible para los seguidores: pedir OK al usuario antes.',
  inputSchema: {
    path: z.string().describe('Ruta absoluta a la imagen o el video'),
    account: z.string().optional().describe('Usuario de Instagram (con o sin @). Opcional si el proyecto fija IG_MCP_ACCOUNT o si hay una sola cuenta guardada'),
    also_facebook: z.boolean().default(false).describe('También como historia de la página de Facebook vinculada'),
    schedule_at: z.string().optional().describe('Programar en vez de publicar ya: segundos unix (como los que da best_times) o fecha ISO 8601 con zona (2026-10-12T18:00-03:00)'),
    dry_run: z.boolean().default(false).describe('Solo sube la foto o el video (sin publicar) para probar sesión y endpoints'),
  },
}, (args) => serial(() => uploadStory(args)));

server.registerTool('best_times', {
  description: 'Los "momentos de más actividad" que Meta recomienda para programar historias (los mismos del botón de Business Suite): tres horarios próximos por canal, con el valor para pasar a upload_story.schedule_at. No publica nada.',
  inputSchema: {
    account: z.string().optional().describe('Usuario de Instagram (con o sin @). Opcional si el proyecto fija IG_MCP_ACCOUNT o si hay una sola cuenta guardada'),
    also_facebook: z.boolean().default(false).describe('Incluir también los horarios de la página de Facebook'),
  },
}, (args) => serial(() => bestTimes(args)));

await server.connect(new StdioServerTransport());
