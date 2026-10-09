# TODO

- [ ] **Links en historias.** Business Suite no ofrece el sticker de link para
  Instagram (el botón "Agregar enlace" aparece desactivado). Ver si
  `story_call_to_action_data` u `overlays` de la mutation lo aceptan, o si hace
  falta otra vía (la web móvil de Instagram).
- [ ] **Música en historias.** Capturar cómo se agrega una canción (en Business
  Suite o en la web móvil) y exponerlo en `upload_story`.
- [ ] **Subir publicaciones.** Una tool `upload_post` para el feed: imagen
  suelta, carrusel y reel, con caption. Capturar el flujo del composer de
  publicaciones de Business Suite como se hizo con el de historias.
- [ ] **Historias programadas.** El composer de Business Suite tiene "Programar"
  además de "Compartir ahora". Capturar qué cambia en la mutation (fecha y hora
  de publicación) y sumar un parámetro `schedule_at` a `upload_story`.
