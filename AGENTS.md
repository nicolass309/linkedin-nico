# Reglas de Generación y Frontera Tecnológica (@nico.innova)

## 1. Verificación Web Activa Obligatoria
- **ANTES** de generar o editar cualquier publicación, borrador, guión o análisis que mencione modelos de IA, frameworks, herramientas, librerías, startups o noticias tecnológicas, es **OBLIGATORIO** ejecutar una búsqueda web con `search_web`.
- Debes verificar específicamente:
  1. El número y nombre exacto de la versión más reciente en producción oficial (ej. Claude Sonnet 5, Gemini 2.5 Pro, OpenAI o3/o4, DeepSeek-V3).
  2. Los anuncios, changelogs, benchmarks o releases de los últimos días o semanas.
  3. Que no se utilicen nombres de modelos o herramientas ya superadas o desfasadas.
- Queda estrictamente **PROHIBIDO** escribir sobre versiones de tecnología basándose únicamente en memoria interna o suposiciones sin verificación web previa.

## 2. Moneda de Frontera (Current State of the Art)
- Las publicaciones técnicas deben reflejar siempre el estado del arte del momento.
- Si un post hace referencia a una herramienta o framework, debe especificar su capacidad actual comprobada en la web.
- Si una noticia o release ocurrió recientemente, debe citarse con exactitud técnica y sin especulaciones.

## 3. Flujo de Publicación Inmutable
- Toda publicación generada debe pasar primero por `posts.json` con `"status": "draft"`.
- Jamás publicar directamente en LinkedIn sin la revisión y aprobación explícita de Nicolás en el dashboard (`https://linkedin-nico.onrender.com`).

## 4. Manual Maestro de Operaciones y Aprendizaje Continuo
- El archivo `WORKFLOW_KNOWLEDGE_BASE.md` es la **fuente única de verdad** de la arquitectura, configuración en producción (Composio, Render, GitHub Actions), historial de errores documentados y reglas editoriales.
- El agente DEBE consultar `WORKFLOW_KNOWLEDGE_BASE.md` antes de planificar cambios o redacciones.
- Cada vez que se aprenda un nuevo requerimiento, se resuelva un bug o se aplique una corrección, el agente DEBE actualizar inmediatamente `WORKFLOW_KNOWLEDGE_BASE.md`.
