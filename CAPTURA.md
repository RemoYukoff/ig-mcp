# Cómo capturar un flujo nuevo de Meta Business Suite

El proceso que se usó para `upload_story`, para repetirlo con lo que falta en
[`TODO.md`](TODO.md) (links, música, publicaciones, programadas). La idea: hacer
la acción una vez a mano en la web, con la sesión real del usuario, registrar
los requests y replicarlos dentro de una página de Business Suite.

## Antes de empezar

- **Navegador con la sesión del usuario.** Con Claude Code, la extensión Claude
  in Chrome (`mcp__claude-in-chrome__*`). Playwright headless no tiene la sesión
  y Meta lo trata distinto.
- **Business Suite, no instagram.com.** La web de Instagram en escritorio no
  ofrece historias, ni siquiera con la ventana angosta: la creación depende del
  user-agent móvil, que la extensión no puede cambiar. Business Suite sí, desde
  `https://business.facebook.com/latest/home` → "Crear historia" / "Crear
  publicación". Revisar en "Compartir en" qué cuentas quedan marcadas: por
  defecto marca también la página de Facebook.
- **Una sola pasada.** Publicar es visible para los seguidores. Instalar el
  registro **antes** de la primera acción real; si falta un request, avisar y
  pedir OK antes de repetir la acción (aunque se cancele sin publicar).
- **Nunca leer el valor de los tokens.** `fb_dtsg`, `lsd`, `jazoest`, cookies:
  se registran los nombres de los campos, no los valores. El clasificador de
  permisos de Claude Code bloquea explorar de dónde salen los tokens; el MCP los
  toma en tiempo de ejecución sin devolverlos (ver más abajo).

## 1. Instalar el registro de requests

`read_network_requests` de la extensión lista URLs pero no bodies, y se
perdió el upload de la foto. Por eso se engancha `XMLHttpRequest` y `fetch` en
la página con `javascript_tool`, después de abrir el composer y antes de tocar
nada:

```js
window.__log = [];
const summarize = (body) => {
  if (!body) return null;
  if (typeof body === 'string') { const o = {}; for (const [k, v] of new URLSearchParams(body)) o[k] = v.slice(0, 3000); return o; }
  if (body instanceof FormData) { const o = {}; for (const [k, v] of body) o[k] = v instanceof Blob ? `<blob ${v.type} ${v.size} ${v.name || ''}>` : String(v).slice(0, 3000); return o; }
  if (body instanceof Blob) return `<blob ${body.type} ${body.size}>`;
  return String(body).slice(0, 500);
};
const oOpen = XMLHttpRequest.prototype.open, oSend = XMLHttpRequest.prototype.send, oSet = XMLHttpRequest.prototype.setRequestHeader;
XMLHttpRequest.prototype.open = function (m, u) { this.__m = m; this.__u = u; this.__h = {}; return oOpen.apply(this, arguments); };
XMLHttpRequest.prototype.setRequestHeader = function (k, v) { this.__h[k] = v; return oSet.apply(this, arguments); };
XMLHttpRequest.prototype.send = function (b) {
  const e = { t: 'xhr', m: this.__m, u: String(this.__u), h: this.__h, body: summarize(b) };
  window.__log.push(e);
  this.addEventListener('load', () => { e.status = this.status; e.resp = String(this.responseText).slice(0, 3000); });
  return oSend.apply(this, arguments);
};
const oFetch = window.fetch;
window.fetch = async function (input, init = {}) {
  const e = { t: 'fetch', m: init.method || 'GET', u: String(input.url || input), h: init.headers, body: summarize(init.body) };
  window.__log.push(e);
  const r = await oFetch.apply(this, arguments);
  e.status = r.status; e.resp = (await r.clone().text()).slice(0, 3000);
  return r;
};
```

Una navegación completa (`navigate`) borra el registro: hay que volver a
instalarlo. Las navegaciones internas de la SPA (por ejemplo, el composer que
vuelve al calendario después de publicar) lo conservan.

## 2. Subir archivos sin el selector nativo

El botón "Agregar foto/video" crea un `<input type=file>` en el momento y le hace
`.click()`, lo que abre el diálogo del sistema (la extensión no lo ve). Se
intercepta ese click para que el input quede en el DOM y se le carga el archivo
con `file_upload`:

```js
window.__origClick = HTMLInputElement.prototype.click;
HTMLInputElement.prototype.click = function () {
  if (this.type === 'file') { this.id = '__claude_file'; if (!this.isConnected) document.body.appendChild(this); return; }
  return window.__origClick.call(this);
};
```

Después: click en el botón, `find` "input type=file" para obtener el `ref`,
`file_upload` con la ruta, y restaurar `HTMLInputElement.prototype.click =
window.__origClick` y borrar `#__claude_file`.

## 3. Leer el registro sin exponer tokens

Las salidas de `javascript_tool` se cortan cerca de los 50 KB y la extensión
bloquea las que contienen query strings o cookies. Conviene leer por partes:

```js
// Índice: qué se llamó
window.__log.map((e, i) => {
  const b = e.body && typeof e.body === 'object' ? e.body : {};
  return [i, e.t, e.m, e.u.split('?')[0], e.status, b.doc_id || '', b.fb_api_req_friendly_name || ''].join(' | ');
}).join('\n')
```

```js
// Un request: nombres de los parámetros, valores solo de los que no son tokens
const e = window.__log[N];
[...new URL(e.u, location.href).searchParams.keys()].join(',') + ' || ' + JSON.stringify(
  Object.fromEntries(Object.entries(e.body).filter(([k]) => !/dtsg|lsd|jazoest|^__/.test(k))))
```

```js
// Variables de una mutation GraphQL, por partes si son largas
JSON.parse(window.__log[N].body.variables)
```

Las respuestas de `/ajax/...` empiezan con `for (;;);`: sacarlo antes de
`JSON.parse`. Las de `/api/graphql/` pueden traer varias líneas JSON; la
primera tiene `data`.

## 4. Qué buscar

- **GraphQL:** `POST /api/graphql/` con `fb_api_req_friendly_name` (el nombre de
  la operación, también en el header `X-FB-Friendly-Name`), `doc_id` (id de la
  consulta persistida) y `variables` (JSON). Lo que se replica es el nombre y la
  forma de `variables`; el resto de los campos son de sesión.
- **Subidas:** van a otro host (`upload-business.facebook.com/ajax/...`) en
  multipart, con los mismos parámetros de sesión en la query string. Devuelven
  un id (`photoID`) que después usa la mutation.
- **Lo que sobra:** `/ajax/bnzai`, `/ajax/webstorage/process_keys/`,
  `bootloader-endpoint`, las queries de navegación (`BusinessCometLeftNavQuery`,
  etc.) y `/business/content/preview/` (solo genera la vista previa).

Lo capturado de historias quedó anotado en el comentario de cabecera de
`server.mjs` y en `publishInPage`.

## 5. Replicarlo en el MCP

Las llamadas corren con `page.evaluate` dentro de una página de Business Suite
abierta en el perfil del MCP, así usan su sesión. Los valores de sesión se leen
de los módulos internos de la página en ese momento, nunca se guardan ni se
devuelven:

| Valor | De dónde sale |
| --- | --- |
| `fb_dtsg` | `require('DTSGInitialData').token` |
| `lsd` | `require('LSD').token` |
| `__user` | `require('CurrentUserInitialData').USER_ID` |
| `jazoest` | `'2'` + suma de los códigos de carácter de `fb_dtsg` |
| resto (`__hs`, `__rev`, `__spin_*`…) | `require('getAsyncParams')('POST')` |
| `av` | el id de la página que publica |
| `doc_id` | `require('<NombreOperacion>_facebookRelayOperation')`, con un valor capturado de respaldo |

El `doc_id` rota con los deploys de Meta; por eso se busca en la página y el
capturado queda solo de respaldo (`IG_MCP_DOC_ID`).

## 6. Datos que no vienen en un request

Algunos datos están embebidos en el HTML de la página ya renderizada, no en un
request propio. Ejemplo: la cuenta de IG y el nombre de la página aparecen en
`page.content()` del composer como

```
{"__typename":"Page","accountName":"…","id":"<pageId>","presenceType":"FACEBOOK",…}
{"__typename":"XFBShadowIGMediaCreatorAccount","accountName":"…","id":"<igId>","presenceType":"INSTAGRAM",…}
```

Para encontrarlos: buscar en `page.content()` un valor conocido (el id de IG
que apareció en las `variables`) e imprimir 200 caracteres alrededor, sacando
antes cualquier `"token"`/`fb_dtsg`. Ojo: un `fetch` de la misma URL devuelve
otro HTML sin esos datos, solo los trae la navegación real.

Para leerlos sin tocar la ventana del usuario (como hace `authenticate`): un
navegador headless aparte con `newContext({ storageState: await
context.storageState() })` copia la sesión en memoria y navega ahí.

## 7. Probar

1. Agregar el flujo con un `dry_run` que haga todo menos el paso que publica.
2. Correr el `dry_run` (`upload_story` con `dry_run: true` sube la foto sin
   crear la historia).
3. El paso que publica se prueba recién con una publicación real, con OK del
   usuario.
4. Éxito de la mutation de historias: `data.xfamily_content_create.errors.instagram_story === null`.
