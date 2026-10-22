# 🧠 Manual Maestro de Operaciones, Reglas y Errores Resueltos (@nico.innova LinkedIn Engine)

Este documento es la **fuente única de verdad (Single Source of Truth)** para el funcionamiento del agente, el motor de publicaciones y el pipeline de LinkedIn de Nicolás Peña Díaz (`@nico.innova`). 

> [!IMPORTANT]
> **REGLA DE ORO:** Este archivo debe ser consultado **antes** de cualquier acción sobre el proyecto y debe **actualizarse obligatoriamente** cada vez que se aprenda un nuevo comportamiento, se resuelva un bug o Nicolás dé una corrección técnica o editorial. Jamás suponer ni halucinar: todo se valida contra este manual y la web en tiempo real.

---

## 🏛️ 1. Arquitectura Técnica y Entorno de Producción

| Componente | Detalle / Configuración |
| :--- | :--- |
| **Perfil LinkedIn** | Nicolás Peña Díaz (`urn:li:person:-4DFGTk-xF`). |
| **API de Publicación** | **Composio LinkedIn API Directo** (MCP / REST). |
| **Servidor Backend** | Node.js + Express en **Render** (`https://linkedin-nico.onrender.com`). |
| **Base de Datos** | `posts.json` local en el servidor, sincronizado automáticamente vía Git API a GitHub. |
| **Repositorio GitHub** | `nicolass309/linkedin-nico` (Rama `main`). |
| **Cron Job Externo** | GitHub Actions (`.github/workflows/keepalive-scheduler.yml`), ejecutándose cada 15 min y a las 9:00 AM Chile. |
| **Endpoint Despertador** | `GET https://linkedin-nico.onrender.com/api/cron/trigger-publish`. |
| **Zona Horaria Oficial** | Chile Continental (`America/Santiago` / CLT, UTC-4 en invierno / UTC-3 en verano). |
| **Horario Habitual** | **Lunes a Viernes a las 10:00 AM CLT** (13:00 / 14:00 UTC). Máximo 1 post diario (salvo re-agendamiento explícito con cooldown). |

---

## 🛡️ 2. Reglas Inmutables de Operación (Non-Negotiable Guardrails)

1. **Flujo de Publicación Obligatorio (Draft First):**
   - Toda nueva publicación generada por IA debe insertarse en `posts.json` con `"status": "draft"`.
   - **Queda estrictamente PROHIBIDO publicar directamente en LinkedIn** sin la previa revisión y clic de aprobación de Nicolás en el dashboard (`https://linkedin-nico.onrender.com`).
2. **Verificación Web Activa Obligatoria (`search_web`):**
   - ANTES de redactar cualquier post sobre IA, frameworks, startups o modelos (Claude, GPT, Gemini, DeepSeek, etc.), es **obligatorio** buscar en la web para verificar versiones exactas oficiales, benchmarks y anuncios recientes.
   - Prohibido apoyarse en memoria interna desactualizada.
3. **Imágenes / Assets Visuales Obligatorios:**
   - Toda publicación programada debe llevar un asset gráfico adjunto (`image`).
   - El backend sube la imagen al S3 de Composio mediante el tool MCP (`upload_local_file`) obteniendo el `s3key` que se enlaza al crear el post en LinkedIn. Ningún post debe salir en texto plano sin foto/diagrama.
4. **Regla Anti-Spam y Límite Diario:**
   - En régimen normal: **1 post por día calendario en Chile**.
   - Si por excepciones se escalonan publicaciones el mismo día, debe existir un **cooldown obligatorio de mínimo 2.5 horas** entre una publicación y la siguiente.
5. **Persistencia Inmediata en GitHub:**
   - Apenas un post se publica, el servidor commitea el cambio a GitHub mediante la API de Git Contents. Así, si Render se reinicia o se duerme, el estado `published` jamás se pierde.

---

## 📜 3. Historial Forense de Errores Documentados y Soluciones Aplicadas

### ❌ Error 1: Repetición Masiva de Posts (4-5 veces en un día - Caso 9 Octubre)
- **Causa Raíz:** Render utiliza contenedores con disco efímero (se borran al apagarse). Al publicarse el post #81, se marcó como `published` en el disco local de Render, pero como la variable de Git no estaba persistiendo a GitHub, cuando el contenedor se durmió y GitHub Actions lo despertó 15 min después, Render releyó el `posts.json` de Git donde el post todavía figuraba `"scheduled"`.
- **Solución Aplicada:**
  1. Conexión de persistencia cloud automática en `server.js` (`syncToGitHub`). Cada publicación exitosa hace un commit inmediato a `nicolass309/linkedin-nico`.
  2. Guard inmutable de día calendario: el sistema valida si hoy ya se publicó y frena el loop.

### ❌ Error 2: Publicador Caído / Cero Publicaciones (Caso 12-14 Octubre)
- **Causa Raíz:** En una edición rápida del guard anti-repeticiones, la variable `publishedCount` se evaluó en una condición antes de ser declarada (`let publishedCount = 0`). Esto generaba un `ReferenceError: publishedCount is not defined` silencioso en el runner que abortaba el ciclo en cada ejecución.
- **Solución Aplicada:**
  1. Se reordenó la inicialización limpia de variables al inicio de `runAutoPublishCycle()`:
     ```javascript
     let updated = false;
     let publishedCount = 0;
     ```
  2. Se validó la sintaxis estricta con `node -c server.js`.
  3. Se reprogramó la cola escalonada y se verificó en vivo que los posts #82, #83, #85, #86 y #87 salieran exitosamente y se sincronizaran en Git.

### ❌ Error 3: Contenedor Dormido y Publicaciones Perdidas por Expiración Rígida
- **Causa Raíz:** El plan gratuito de Render se duerme tras 15 minutos sin peticiones web. Antes, si nadie entraba al front a las 9:00 AM exactas, el servidor despertaba tarde y una regla rígida de "2 horas de margen" marcaba el post como expirado sin publicarlo.
- **Solución Aplicada:**
  1. Se amplió la ventana a **"Misma Jornada Laboral de Chile" (09:00 AM a 21:00 PM CLT)**. Si un post está agendado para hoy, se publicará apenas el servidor reciba un ping dentro de ese horario.
  2. Los posts de días anteriores (`postDateChileStr < nowChileStr`) se expiran de forma segura en la base de datos sin enviarse a LinkedIn.
  3. Se creó el workflow de GitHub Actions que hace ping al endpoint `/api/cron/trigger-publish` cada 15 minutos de forma perpetua.

### ❌ Error 4: Clics Múltiples de Aprobación en el Frontend
- **Causa Raíz:** Al aprobar un borrador, la UI tardaba unos segundos en responder. Si el usuario hacía clic varias veces seguidas, se enviaban múltiples peticiones al backend.
- **Solución Aplicada:**
  1. Se agregó debounce y set de IDs en tránsito (`approvingIds`) en `public/app.js`.
  2. En `server.js` (`/api/posts/:id/approve`), si el post ya está en estado `scheduled` o `published`, se retorna el post existente de forma idempotente sin duplicar slots en el calendario.

---

## ✍️ 4. Guía Editorial y Calibración Anti-Slop (@nico.innova)

Basado en el análisis de las métricas reales de los 365 días de Nicolás Peña Díaz:

### Lo que Funciona (Alto Alcance e Interacción):
1. **Controversia Técnica / Contrarian Truths:** Desmentir mitos comunes de ingeniería (ej. *"El error de contratar seniors que rechazan IA"*, *"El Prompt Engineering murió: importa la Arquitectura de Contexto"*).
2. **Arquitecturas y Números Reales:** Stacks con costos exactos (ej. VPS de $5, modelos de $0.002 por cuenta, tiempos de sprint de 4 horas vs 1 semana).
3. **Casos Locales / Silicon Valley:** Hitos reales de startups chilenas o latinoamericanas (ej. Sintropix en Y Combinator, integraciones con SII/facturación local).
4. **Enfoque Save-First (Dwell Time & Guardados):** Diseñar posts con frameworks estructurados y listas técnicas accionables que obliguen al usuario a hacer clic en 'Guardar'.
5. **Debate Profesional Genuino:** Cerrar con preguntas técnicas abiertas dirigidas a directores, CTOs e ingenieros para generar hilos de comentarios profundos.

### Lo que Está Prohibido (Anti-IA Slop y Penalizaciones Algorítmicas):
- ❌ **Comment Baiting:** Prohibido usar cierres tipo *"Comenta STACK"*, *"Comenta SCHEMA"* o *"Comenta X"*. El algoritmo actual (360Brew) detecta engagement artificial y recorta el alcance entre 40% y 50%.
- ❌ Frases cliché de IA: *"En el vertiginoso mundo de hoy"*, *"Un cambio de paradigma revolucionario"*, *"La IA llegó para quedarse"*, *"Sinfonía de innovación"*.
- ❌ Muros de texto sin respiración: Párrafos de más de 3 líneas. Usar siempre saltos de línea limpios y listas con guiones.
- ❌ Posts abstractos sin herramientas ni código: Todo post debe nombrar tecnologías tangibles (N8N, Docker, Zod, Composio, PostgreSQL, FastMCP, Claude, MCP, etc.).

---

## 🔄 5. Protocolo de Actualización de Este Documento

Cada vez que:
1. Se modifique una ruta en `server.js` o la configuración del cron en GitHub Actions.
2. Ocurra cualquier incidente o error en producción.
3. Se añada una nueva regla editorial o preferencia por parte de Nicolás.

**El agente debe:**
- Editar este archivo `WORKFLOW_KNOWLEDGE_BASE.md`.
- Registrar la lección aprendida en la sección correspondiente.
- Hacer commit y push a `main`.
