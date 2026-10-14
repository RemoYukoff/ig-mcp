# TODO

- [ ] **Links en historias.** Business Suite no ofrece el sticker de link para
  Instagram (el botón "Agregar enlace" aparece desactivado). Ver si
  `story_call_to_action_data` u `overlays` de la mutation lo aceptan, o si hace
  falta otra vía (la web móvil de Instagram).
- [ ] **Música en historias.** Business Suite no la ofrece (revisado el
  2026-10-10: el editor de la foto solo tiene Ajustar, Texto, Mención y
  stickers). Queda la web móvil de Instagram.
- [ ] **Subir publicaciones.** Una tool `upload_post` para el feed: imagen
  suelta, carrusel y reel, con caption. Capturar el flujo del composer de
  publicaciones de Business Suite como se hizo con el de historias.
- [ ] **Probar una historia programada real.** `schedule_at` y `best_times` están
  hechos y probados con `dry_run`, pero la forma de `unpublished_content_data`
  salió del código de la página, no de un request capturado. Falta programar
  una de verdad y confirmar que aparece en el Planificador.
- [ ] **Publicar un video real desde el MCP.** La subida de video está probada
  con `dry_run` (sube y procesa); la mutation de la historia con
  `{ video: { id } }` se capturó publicando a mano desde la web el 2026-10-14,
  pero falta una publicación real hecha por `upload_story`.
