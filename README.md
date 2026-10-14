# ig-mcp

MCP para publicar en Instagram desde Meta Business Suite con la sesión
de cualquier cuenta de Facebook, para cualquier página que tenga una cuenta de
Instagram vinculada. Por ahora publica historias; lo que falta está en
[`TODO.md`](TODO.md) y cómo capturar un flujo nuevo de la web, en
[`CAPTURA.md`](CAPTURA.md).

Hace lo mismo que el composer de historias de Business Suite: sube la foto
(`upload-business.facebook.com/ajax/react_composer/attachments/photo/upload`)
o el video (`vupload-edge-business.facebook.com` + `rupload.facebook.com`) y
publica con la mutation `BusinessComposerStoryCreationMutation` de
`/api/graphql/`. Las llamadas salen desde una página de Business Suite abierta en
un perfil de Brave propio, así usan la sesión y los tokens de esa página. No usa
la Graph API ni necesita una app de Meta.

## Instalación

Necesita Node 20+ y un navegador Chromium (por defecto Brave en `/usr/bin/brave`;
otro con `IG_MCP_BROWSER`).

```bash
git clone https://github.com/RemoYukoff/ig-mcp.git
cd ig-mcp && npm install
claude mcp add --scope user ig-mcp -- node "$PWD/server.mjs"
```

## Tools

| Tool | Qué hace |
| --- | --- |
| `authenticate` | Abre Brave. Iniciás sesión en Facebook y elegís en Business Suite la página; un recuadro flotante muestra en vivo la página y la cuenta de IG detectadas. Con `IG_MCP_ACCOUNT` no hay botón: la ventana se cierra sola cuando detecta esa cuenta y con otra queda abierta avisando. Sin ella, **Confirmar** guarda la que se ve. `profile` separa cuentas de Facebook distintas (por defecto `default`). |
| `list_accounts` | Cuentas de IG guardadas, su página, su perfil y si la sesión sigue activa. |
| `upload_story` | `path` (ruta absoluta, .png/.jpg o .mp4/.mov con su audio, 1080×1920), `account` (usuario de IG; opcional si hay una sola), `also_facebook`, `schedule_at` (programar: segundos unix o ISO 8601 con zona), `dry_run` (sube la foto o el video sin publicar). |
| `best_times` | Los "momentos de más actividad" de Business Suite: tres horarios próximos por canal, con el valor para `schedule_at`. `account`, `also_facebook`. No publica. |

## Una cuenta por proyecto

El registro de usuario sirve en todos los proyectos. Para fijar la cuenta de un
proyecto, agregar en su raíz un `.mcp.json` con el mismo nombre de server:
pisa al de usuario, `authenticate` espera esa cuenta y `upload_story` usa solo
esa (rechaza cualquier otra).

```json
{
  "mcpServers": {
    "ig-mcp": {
      "command": "node",
      "args": ["/ruta/a/ig-mcp/server.mjs"],
      "env": { "IG_MCP_ACCOUNT": "mi.cuenta" }
    }
  }
}
```

Se puede setear al instalarlo: `claude mcp add --scope project ig-mcp -e IG_MCP_ACCOUNT=<usuario> -- node …/server.mjs`
(`--scope local` para que no quede en el repo). Las sesiones y `accounts.json`
son compartidos entre proyectos.

## Datos

`~/.local/share/ig-mcp/` (o `IG_MCP_HOME`):

- `profiles/<perfil>/`: perfil de navegador con la sesión de Facebook.
- `accounts.json`: `{ "<usuario IG>": { username, igId, pageId, businessId, profile, savedAt } }`.

El MCP nunca devuelve cookies ni tokens: solo dice si hay sesión y cuándo vence.

## Variables

| Variable | Por defecto |
| --- | --- |
| `IG_MCP_ACCOUNT` | sin fijar (cuenta del proyecto, ver arriba) |
| `IG_MCP_HOME` | `~/.local/share/ig-mcp` |
| `IG_MCP_BROWSER` | `/usr/bin/brave` |
| `IG_MCP_HEADLESS` | `1` (`0` para ver el navegador al publicar) |
| `IG_MCP_DOC_ID` | `doc_id` de la mutation capturado el 2026-10-09 |

## Límites

- Imágenes y videos (el video va con el audio que ya tenga mezclado). Sin
  stickers ni la música de Instagram (Business Suite no ofrece sticker de link
  para IG ni música en historias).
- Es la API interna de la web de Meta, no una pública: puede romperse cuando
  Meta cambie la web, y automatizar la sesión va contra sus términos.
- El `doc_id` de la mutation rota con los deploys de Meta. Se busca el vigente en
  la página; si no aparece y el viejo falla, el error lo dice: capturar el nuevo
  publicando una historia a mano en Business Suite y pasarlo en `IG_MCP_DOC_ID`.
