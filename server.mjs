#!/usr/bin/env node
// MCP para publicar historias de Instagram desde Meta Business Suite, con la
// sesión de cualquier cuenta de Facebook y para cualquier página con una
// cuenta de Instagram vinculada.
//
// Replica lo que hace el composer de historias de Business Suite (capturado el
// 2026-10-09): sube la foto a
// upload-business.facebook.com/ajax/react_composer/attachments/photo/upload
// y publica con la mutation BusinessComposerStoryCreationMutation de /api/graphql/.
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

const BS = 'https://business.facebook.com/latest/';
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

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

// Corre dentro de la página de Business Suite: sube la foto y publica.
async function publishInPage({ b64, name, mime, pageId, igId, docIdFallback, alsoFacebook, dryRun }) {
  const req = window.require;
  const dtsg = req('DTSGInitialData').token;
  let lsd = '';
  try { lsd = req('LSD').token; } catch {}
  const userId = req('CurrentUserInitialData').USER_ID;
  let sum = 0;
  for (const ch of dtsg) sum += ch.charCodeAt(0);
  let asyncParams = {};
  try { asyncParams = req('getAsyncParams')('POST'); } catch {}
  const common = { ...asyncParams, av: pageId, __user: userId, __a: '1', fb_dtsg: dtsg, jazoest: `2${sum}`, lsd };

  // 1. Subida de la foto
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
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
  if (dryRun) return { photoId, dryRun: true };

  // 2. Publicación
  let docId = docIdFallback;
  try { docId = req('BusinessComposerStoryCreationMutation_facebookRelayOperation') || docIdFallback; } catch {}
  const photo = { photo: { id: photoId, story_call_to_action_data: null, overlays: [] } };
  const variables = {
    input: {
      client_mutation_id: '1',
      base: {
        actor_id: pageId,
        composer_entry_point: 'biz_web_home_stories',
        source: 'WWW',
        unpublished_content_data: null,
        attachments: [photo],
        story_original_attachments_data: [
          { original_photo_id: photoId, burned_photo: { story_call_to_action_data: null, id: photoId, overlays: [] } },
        ],
      },
      channels: alsoFacebook ? ['FACEBOOK_STORY', 'INSTAGRAM_STORY'] : ['INSTAGRAM_STORY'],
      identities: [pageId, igId],
      FACEBOOK_STORY: { geo_gating: null, attachments: [photo] },
      INSTAGRAM_STORY: { targeted_privacy_data: null, attachments: [photo] },
      logging: { composer_session_id: crypto.randomUUID() },
    },
    checkPhotosToReelsUpsellEligibility: false,
  };
  const body = new URLSearchParams({
    ...common,
    fb_api_caller_class: 'RelayModern',
    fb_api_req_friendly_name: 'BusinessComposerStoryCreationMutation',
    server_timestamps: 'true',
    variables: JSON.stringify(variables),
    doc_id: docId,
  });
  const res = await fetch('/api/graphql/', {
    method: 'POST',
    body,
    credentials: 'include',
    headers: { 'X-FB-Friendly-Name': 'BusinessComposerStoryCreationMutation', 'X-FB-LSD': lsd },
  });
  const resText = await res.text();
  let json = {};
  try { json = JSON.parse(resText.split('\n')[0]); } catch {}
  const created = json.data?.xfamily_content_create;
  if (!created) {
    return { step: 'publish', photoId, docId, status: res.status, error: json.errors?.[0]?.message ?? resText.slice(0, 200) };
  }
  return { photoId, docId, errors: created.errors };
}

async function uploadStory({ path, account, also_facebook, dry_run }) {
  const accounts = await loadAccounts();
  const names = Object.keys(accounts);
  // La cuenta fijada es la que se usa por defecto y la única permitida, para no
  // publicar por error en la de otro proyecto.
  const asked = account?.replace(/^@/, '') || null;
  if (PINNED && asked && asked !== PINNED) return fail(`Este proyecto está fijado a @${PINNED} (IG_MCP_ACCOUNT); no publica en @${asked}.`);
  const wanted = asked ?? PINNED;
  const acc = wanted ? accounts[wanted] : names.length === 1 ? accounts[names[0]] : null;
  if (!acc) {
    if (!names.length) return fail('No hay cuentas guardadas: correr authenticate.');
    return fail(`${wanted ? `No hay una cuenta @${wanted} guardada.` : 'Hay varias cuentas: indicar account.'} Guardadas: ${names.map((n) => '@' + n).join(', ')}.`);
  }

  const file = resolve(path);
  const mime = MIME[extname(file).toLowerCase()];
  if (!mime) return fail(`Formato no soportado: ${extname(file)}. Usar .png o .jpg.`);
  const { size } = await stat(file);
  if (size > 30 * 1024 * 1024) return fail(`El archivo pesa ${(size / 1e6).toFixed(1)} MB; el máximo es 30 MB.`);
  const b64 = (await readFile(file)).toString('base64');

  const context = await openProfile(acc.profile, HEADLESS);
  try {
    if (!(await sessionInfo(context)).loggedIn) return fail(`El perfil "${acc.profile}" no tiene sesión: correr authenticate.`);
    const page = context.pages()[0] ?? (await context.newPage());
    const found = await openComposer(page, acc);
    if (!found) return fail('La sesión venció o Meta pidió verificar la cuenta: correr authenticate.');
    // El id de IG se toma fresco de la página: si la cuenta se desvinculó, no se publica.
    const current = found.ig.find((a) => a.username === acc.username);
    if (!current) return fail(`La página ${acc.pageId} ya no muestra @${acc.username} en Business Suite (ve: ${found.ig.map((a) => '@' + a.username).join(', ') || 'ninguna'}).`);

    const r = await page.evaluate(publishInPage, {
      b64, name: basename(file), mime, pageId: acc.pageId, igId: current.igId,
      docIdFallback: DOC_ID_FALLBACK, alsoFacebook: also_facebook, dryRun: dry_run,
    });

    if (r.error) {
      const hint = r.step === 'publish' ? ` Si el doc_id (${r.docId}) quedó viejo, capturar el nuevo y pasarlo en IG_MCP_DOC_ID.` : '';
      return fail(`Falló el paso ${r.step} (HTTP ${r.status}): ${r.error}.${hint}`);
    }
    if (r.dryRun) return text(`Dry run en @${acc.username}: foto subida sin publicar (photoID ${r.photoId}). No se creó ninguna historia.`);

    const channels = also_facebook ? ['instagram_story', 'facebook_story'] : ['instagram_story'];
    const broken = Object.entries(r.errors ?? {}).filter(([k, v]) => v && channels.includes(k));
    if (broken.length) return fail(`Meta devolvió errores: ${JSON.stringify(Object.fromEntries(broken))}`);
    return text(`Historia publicada en @${acc.username}${also_facebook ? ' y en su página de Facebook' : ''} (photoID ${r.photoId}, doc_id ${r.docId}). Puede tardar unos minutos en aparecer.`);
  } finally {
    await context.close();
  }
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
  description: 'Publica una imagen (.png o .jpg, idealmente 1080×1920) como historia de Instagram vía Meta Business Suite. No admite sticker de link ni video. Publicar es visible para los seguidores: pedir OK al usuario antes.',
  inputSchema: {
    path: z.string().describe('Ruta absoluta a la imagen'),
    account: z.string().optional().describe('Usuario de Instagram (con o sin @). Opcional si el proyecto fija IG_MCP_ACCOUNT o si hay una sola cuenta guardada'),
    also_facebook: z.boolean().default(false).describe('También como historia de la página de Facebook vinculada'),
    dry_run: z.boolean().default(false).describe('Solo sube la foto (sin publicar) para probar sesión y endpoint'),
  },
}, (args) => serial(() => uploadStory(args)));

await server.connect(new StdioServerTransport());
