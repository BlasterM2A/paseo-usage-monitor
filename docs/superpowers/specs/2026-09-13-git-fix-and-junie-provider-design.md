# Design Doc: Fix de Instalación Git, Validación de Antigravity/Copilot y Proveedor Junie

**Fecha:** 2026-09-13  
**Repositorio:** `BlasterM2A/paseo-usage-monitor`  
**Estado:** Aprobado

---

## 1. Contexto y Objetivos

El plugin `usage-monitor` para Paseo (v0.8.0) monitoriza consumos de tokens, límites de cuotas y balances de modelos de IA.
Este proyecto aborda tres necesidades clave:
1. **Fix de instalación vía Git**: Permitir que `paseo plugin add BlasterM2A/paseo-usage-monitor` se instale y compile limpiamente sin errores de resolución de tipos.
2. **Validación y robustez de Antigravity y Copilot**: Garantizar su funcionamiento en entornos Linux con soporte para `ANTIGRAVITY_TOKEN` y descripciones claras sin alertas alarmistas.
3. **Soporte para JetBrains Junie**: Diseñar e implementar la telemetría histórica (gráfico de tokens/modelos) y tarjeta de monitorización de cuotas/balance para Junie.

---

## 2. Sección 1: Fix de Compilación e Instalación Git

### Diagnóstico
Paseo 0.8 compila los plugins clonados mediante `esbuild` y un validador de fronteras de TypeScript (`paseo-plugin-server-runtime-boundary`).
Al no correr `npm install` automáticamente en clones limpios, fallaba al intentar resolver `@getpaseo/client` y `@getpaseo/protocol`, los cuales no forman parte de los módulos provistos por el host.

### Solución
* **Servidor**:
  * En `server/handlers.server.ts` y `server/limit-alerts.server.ts`, cambiar:
    ```typescript
    import type { PluginHandlerContext } from "@getpaseo/plugin/server";
    type PaseoApi = PluginHandlerContext["paseo"];
    ```
* **Cliente**:
  * En `client/limit-alerts.client.tsx`:
    ```typescript
    type PaseoApi = ReturnType<typeof usePaseo>;
    ```
  * Reemplazar la importación de `@getpaseo/protocol/agent-types` por una interfaz estructural local compatible para el payload del timeline.
* **Manifiesto (`paseo-plugin.json`)**:
  * Añadir `"build": [["npm", "install", "--omit=dev"]]`.

---

## 3. Sección 2: Robustez y Validación de Antigravity y Copilot

### Diagnóstico
Los probes de `antigravity` y `github-copilot` están completamente desarrollados pero marcados como `unverified` en el catálogo de presets y descripciones. En Linux, `antigravity-probe` depende de D-Bus / Secret Service, lo que puede fallar si la sesión gráfica de keyring no está disponible.

### Solución
* **Probe Antigravity (`server/antigravity-probe.server.ts`)**:
  * Añadir soporte prioritario para la variable de entorno `ANTIGRAVITY_TOKEN` antes de llamar a D-Bus.
  * Si la conexión D-Bus falla, emitir mensaje guiado con instrucciones de autenticación o uso de variable de entorno.
* **Catálogo de Presets (`shared/presets.shared.ts`)**:
  * Actualizar descripciones de `antigravity` y `github-copilot` para reflejar que están verificados en Linux y macOS.
* **Tests unitarios**:
  * Actualizar `server/config-store.test.ts` con los nuevos patrones de descripción.

---

## 4. Sección 3: Proveedor de JetBrains Junie

### Diagnóstico
Junie registra todas sus interacciones LLM en `~/.junie/sessions/*/events.jsonl` emitiendo eventos `LlmResponseMetadataEvent` que contienen:
* `model`: Nombre del modelo (ej. `gpt-4.1`, `qwen-flash`).
* `inputTokens`, `cacheInputTokens`, `cacheCreateTokens`, `outputTokens`.
* `cost`: Coste reportado en USD.
* `timestampMs`: Marca de tiempo del evento.
* `taskId`: ID de la tarea.
Y en caso de fondos agotados emite:
* `ExitPaymentRequired`: *"Junie: Insufficient account balance. All tokens in your account have been spent."*
Asimismo, almacena credenciales en `~/.junie/secure_credentials.json` (`ast_token` y `jb-account-stored`).

### Arquitectura de Junie
1. **Historial (`server/history.server.ts`)**:
   * Constante `JUNIE_PROVIDER_ID = "junie"` y etiqueta `"JetBrains Junie"`.
   * Incluir `~/.junie/sessions` en los directorios de escaneo.
   * Parseador de eventos `events.jsonl` que proyecte cada `LlmResponseMetadataEvent` en `UsageRow`.
2. **Probe en vivo (`server/junie-probe.server.ts`)**:
   * Comprueba credenciales locales de Junie.
   * Inspecciona la última sesión: si terminó con `ExitPaymentRequired`, reporta estado de agotamiento con advertencia (0% balance). Si está activa, reporta estado saludable y consumo acumulado.
3. **Preset (`shared/presets.shared.ts`)**:
   * Registrar preset `junie` con `probe: "junie"`.
   * Conectar el probe en `server/source.server.ts`.

---

## 5. Criterios de Éxito y Verificación

1. `npm run typecheck` pasa con 0 errores de TypeScript.
2. `npm test` pasa el 100% de los tests existentes y los nuevos para Junie.
3. `paseo plugin add BlasterM2A/paseo-usage-monitor` se ejecuta directamente desde Git sin errores de build.
4. Las tarjetas de Antigravity, Copilot y Junie cargan y reportan datos correctamente en el dashboard de Paseo.
