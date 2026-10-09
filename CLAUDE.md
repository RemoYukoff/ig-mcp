# ig-mcp

MCP que publica en Instagram replicando los requests internos de Meta Business
Suite (`server.mjs`). Qué hace y cómo se usa: [`README.md`](README.md). Lo que
falta: [`TODO.md`](TODO.md).

- **Para sumar un flujo nuevo** (links, música, publicaciones, programadas),
  seguir [`CAPTURA.md`](CAPTURA.md): cómo registrar los requests en el
  navegador del usuario, leerlos sin exponer tokens y replicarlos en el MCP.
- **Publicar es visible para los seguidores:** pedir OK antes de cada
  publicación real, y antes de repetir una acción en la web para capturarla.
- **Nunca leer ni devolver valores de tokens o cookies.** El MCP los toma de la
  página en tiempo de ejecución; las tools solo dicen si hay sesión.
- Probar con `dry_run` antes que con una publicación real.
