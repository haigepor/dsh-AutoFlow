"use strict";
(() => {
  // src/client/afp-workbench.js
  function createWorkbench(React, Switch, ctx, t, store) {
    const h = React.createElement;
    return function AfpWorkbench() {
      const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      const active = state.status?.features ?? [];
      const action = (operation, args = {}) => {
        void store.invoke(operation, args);
      };
      const button = (label, operation, args, disabled = false) => h("button", { type: "button", className: "afp-button", disabled: state.busy || disabled, onClick: () => action(operation, args) }, t(label));
      const selected = state.selected;
      return h(
        "section",
        { className: "afp-workbench", "aria-label": t("title") },
        h("header", { className: "afp-header" }, h("div", null, h("h2", null, t("title")), h("p", { className: "afp-muted" }, t("scope"))), button("reload", "status")),
        state.error ? h("p", { role: "alert", className: "afp-error" }, `${t("error")}: ${state.error}`) : null,
        !state.status ? h("p", { role: "status" }, t("loading")) : null,
        h(
          "section",
          { className: "afp-section" },
          h("h3", null, t("credentials")),
          h("p", { className: "afp-muted" }, t("credentialHelp")),
          h(
            "div",
            { className: "afp-lines" },
            ...Object.entries(state.status?.credentials ?? {}).map(([key, value]) => h("div", { key, className: "afp-line" }, h("span", null, t(key)), h("span", null, t(value ? "configured" : "missing")))),
            h("div", { className: "afp-line" }, h("span", null, t("vision")), h("span", null, t(state.status?.visionConfigured ? "configured" : "missing")))
          )
        ),
        h(
          "section",
          { className: "afp-section" },
          h("h3", null, t("features")),
          ...["script", "skill", "ui"].map((kind) => h(
            "div",
            { key: kind },
            h("h4", null, t(kind)),
            ...(state.features ?? []).filter((feature) => feature.kind === kind).map((feature) => h(
              "div",
              { className: "afp-line", key: feature.id },
              h(
                "div",
                null,
                h("strong", null, ctx.locale.resolveText(feature.title)),
                h("p", { className: "afp-muted" }, ctx.locale.resolveText(feature.description)),
                h("small", { className: "afp-muted" }, `${t(feature.enabled ? "selected" : "unselected")} \xB7 ${t(feature.running ? "running" : "stopped")}`)
              ),
              h(Switch, { checked: feature.enabled, label: ctx.locale.resolveText(feature.title), loading: state.saving.includes(feature.id), onChange: (next) => {
                void store.toggle(feature.id, next);
              } })
            ))
          ))
        ),
        h(
          "section",
          { className: "afp-section" },
          h("h3", null, t("curation")),
          h("div", { className: "afp-categories" }, ...(state.status?.categories ?? []).map((category) => h(
            "label",
            { key: category },
            h("input", { type: "checkbox", checked: selected.includes(category), onChange: (event) => store.set({ selected: event.target.checked ? [...selected, category] : selected.filter((key) => key !== category) }) }),
            t(category)
          ))),
          h(
            "div",
            { className: "afp-toolbar" },
            h("input", { className: "afp-input", value: state.query, placeholder: t("query"), "aria-label": t("query"), onChange: (event) => store.set({ query: event.target.value }) }),
            button("search", "search", { query: state.query }, !active.includes("read") || !state.query.trim()),
            button("collections", "collections", {}, !active.includes("read"))
          ),
          h(
            "div",
            { className: "afp-toolbar" },
            button("refresh", "refresh", { categories: selected }, !active.includes("refresh") || !selected.length),
            h("input", { className: "afp-input", value: state.runId, placeholder: t("runId"), "aria-label": t("runId"), onChange: (event) => store.set({ runId: event.target.value }) }),
            button("resume", "refresh", { runId: state.runId }, !active.includes("refresh") || !state.runId)
          ),
          h(
            "div",
            { className: "afp-toolbar" },
            h("select", { className: "afp-input", value: state.operation, "aria-label": t("operation"), onChange: (event) => store.set({ operation: event.target.value }) }, ...["append", "replace", "clear"].map((operation) => h("option", { key: operation, value: operation }, t(operation)))),
            button("preview", "plan", { operation: state.operation, categories: selected, ...state.operation === "clear" ? {} : { runId: state.runId } }, !active.includes("write") || !selected.length || state.operation !== "clear" && !state.runId)
          )
        ),
        state.plan ? h(
          "section",
          { className: "afp-section afp-confirm", role: "region", "aria-label": t("confirmation") },
          h("h3", null, t("confirmation")),
          h("p", { className: "afp-muted" }, t("writeWarning")),
          h(
            "table",
            null,
            h("thead", null, h("tr", null, ...["target", "remove", "add"].map((key) => h("th", { key }, t(key))))),
            h("tbody", null, ...state.plan.categories.map((item) => h("tr", { key: item.category }, h("td", null, item.selectionName), h("td", null, item.remove), h("td", null, item.add))))
          ),
          h("p", { className: "afp-muted" }, `${t("expires")}: ${new Date(state.plan.expiresAt).toLocaleString()}`),
          h("div", { className: "afp-toolbar" }, button("confirm", "confirm", { planId: state.plan.planId, confirmation: state.plan.confirmation, confirmed: true }, !active.includes("write")), h("button", { className: "afp-button", type: "button", onClick: () => store.set({ plan: null }) }, t("dismiss")))
        ) : null,
        h(
          "section",
          { className: "afp-section" },
          h("h3", null, t("tasks")),
          ...(state.status?.tasks ?? []).map((task) => h("div", { key: task.taskId, className: "afp-line" }, h("div", null, h("code", null, task.taskId), task.progress ? h("pre", { className: "afp-report", role: "status" }, task.progress) : null), h("span", null, t(task.feature === "write" ? "write" : "refresh")), button("cancel", "cancel", { taskId: task.taskId }))),
          !state.status?.tasks?.length ? h("p", { className: "afp-muted" }, t("noTasks")) : null,
          ...(state.status?.reports ?? []).map((report) => h("details", { key: report.runId ?? report.planId }, h("summary", null, `${report.runId ?? report.planId} \xB7 ${report.status ?? report.state}`), h("pre", { className: "afp-report" }, JSON.stringify(report, null, 2))))
        ),
        state.result ? h("section", { className: "afp-section" }, h("h3", null, t("result")), h("pre", { className: "afp-report", role: "status" }, JSON.stringify(state.result, null, 2))) : null
      );
    };
  }

  // src/client/afp-client-store.js
  var NAME = "dsh-plugin-afp";
  function createAfpClientStore(ctx) {
    let state = { status: null, features: [], selected: ["food"], query: "", runId: "", operation: "append", result: null, plan: null, busy: false, saving: [], error: "" };
    const listeners = /* @__PURE__ */ new Set();
    let disposed = false, poll, featureQueue = Promise.resolve();
    const set = (update) => {
      if (!disposed) {
        state = { ...state, ...update };
        for (const listener of listeners) listener();
      }
    };
    async function call(operation, args = {}) {
      const result = await ctx.remote.pluginManager.invokeAction(NAME, "workbench", { operation, args: JSON.stringify(args) });
      if (!result.ok) throw new Error(result.error.message);
      return JSON.parse(result.value.output);
    }
    async function reload() {
      if (poll) return poll;
      poll = Promise.all([call("status"), ctx.remote.pluginManager.listBundles(), ctx.remote.pluginManager.listPlugins()]).then(([status, bundles, plugins]) => {
        if (!bundles.ok) throw new Error(bundles.error.message);
        if (!plugins.ok) throw new Error(plugins.error.message);
        const bundle = bundles.value.find((bundle2) => bundle2.name === NAME);
        if (bundle?.error) throw new Error(bundle.error.diagnostic ?? bundle.error.code);
        set({
          status,
          features: (bundle?.features ?? []).map((feature) => ({
            ...feature,
            running: plugins.value.some((row) => row.patchId === feature.rowId && row.enabled && row.fiberPhase === "active")
          })),
          ...status.features.includes("write") ? {} : { plan: null }
        });
      }).catch((error) => set({ error: error.message })).finally(() => {
        poll = null;
      });
      return poll;
    }
    const store = {
      getSnapshot: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      set,
      reload,
      async invoke(operation, args) {
        if (state.busy) return;
        set({ busy: true, error: "" });
        try {
          if (operation === "status") {
            await reload();
            return;
          }
          const result = await call(operation, args);
          set({
            result: operation === "plan" ? { ...result, confirmation: void 0 } : result,
            ...operation === "plan" ? { plan: result } : {},
            ...operation === "confirm" ? { plan: null } : {},
            ...result.runId ? { runId: result.runId } : {}
          });
          await reload();
        } catch (error) {
          set({ error: error.message, ...operation === "confirm" ? { plan: null } : {} });
        } finally {
          set({ busy: false });
        }
      },
      toggle(id, enabled) {
        if (state.saving.includes(id)) return;
        set({ saving: [...state.saving, id], error: "" });
        featureQueue = featureQueue.then(async () => {
          const bundles = await ctx.remote.pluginManager.listBundles();
          if (!bundles.ok) throw new Error(bundles.error.message);
          const features = bundles.value.find((bundle) => bundle.name === NAME)?.features ?? [];
          const ids = features.filter((feature) => feature.id === id ? enabled : feature.enabled).map((feature) => feature.id);
          const result = await ctx.remote.pluginManager.setBundleFeatures(NAME, ids, false);
          if (!result.ok) throw new Error(result.error.message);
          if (result.value.application === "failed") throw new Error(result.value.error?.diagnostic ?? "AFP configuration save failed");
          await reload();
        }).catch((error) => set({ error: error.message })).finally(() => set({ saving: state.saving.filter((key) => key !== id) }));
        return featureQueue;
      },
      dispose() {
        disposed = true;
        listeners.clear();
      }
    };
    return store;
  }

  // src/client/afp-configuration-form.js
  function createConfigurationForm(React, { Input, Button, StateDot }, ctx, t) {
    const h = React.createElement;
    return function ConfigurationForm({ view }) {
      const [loaded, setLoaded] = React.useState(null), [text, setText] = React.useState(""), [secrets, setSecrets] = React.useState({});
      const [message, setMessage] = React.useState(""), [busy, setBusy] = React.useState(false), [acquiringToken, setAcquiringToken] = React.useState(false);
      const [draft, setDraft] = React.useState({});
      React.useEffect(() => {
        if (view !== "page") return;
        let mounted = true;
        void ctx.remote.pluginManager.invokeAction("dsh-plugin-afp", "configuration", { operation: "read" }).then((result) => {
          if (!mounted) return;
          if (!result.ok) {
            setMessage(t("configFailed"));
            return;
          }
          const value = JSON.parse(result.value.output);
          setLoaded(value);
          setDraft(value.config);
          setText(JSON.stringify(value.config, null, 2));
        }).catch(() => {
          if (mounted) setMessage(t("configFailed"));
        });
        return () => {
          mounted = false;
        };
      }, [view]);
      if (view !== "page") return t("configHelp");
      async function credential(key) {
        setBusy(true);
        setMessage("");
        try {
          const result = await ctx.remote.credentials.set(loaded.config[key], secrets[key]);
          if (!result.ok) throw new Error();
          setSecrets((current) => ({ ...current, [key]: "" }));
          setMessage(t("credentialSaved"));
        } catch (error) {
          setMessage(t("configFailed"));
        } finally {
          setBusy(false);
        }
      }
      async function acquireToken() {
        const username = String(secrets.usernameRef ?? "").trim(), password = String(secrets.passwordRef ?? "");
        if (!username || !password) {
          setMessage(t("tokenCredentialsRequired"));
          return;
        }
        setAcquiringToken(true);
        setBusy(true);
        setMessage(t("tokenAcquiring"));
        try {
          const usernameSaved = await ctx.remote.credentials.set(loaded.config.usernameRef, username);
          const passwordSaved = await ctx.remote.credentials.set(loaded.config.passwordRef, password);
          if (!usernameSaved.ok || !passwordSaved.ok) throw new Error();
          const result = await ctx.remote.pluginManager.invokeAction("dsh-plugin-afp", "configuration", { operation: "acquire-token" });
          if (!result.ok) throw new Error();
          setSecrets((current) => ({ ...current, usernameRef: "", passwordRef: "" }));
          setMessage(t("tokenAcquired"));
        } catch (error) {
          setMessage(t("tokenAcquireFailed"));
        } finally {
          setBusy(false);
          setAcquiringToken(false);
        }
      }
      async function save() {
        setBusy(true);
        setMessage("");
        try {
          JSON.parse(text);
          const result = await ctx.remote.pluginManager.invokeAction("dsh-plugin-afp", "configuration", { operation: "save", config: text, revision: loaded.revision });
          if (!result.ok) throw new Error();
          setLoaded(null);
          setMessage(t("configSaved"));
        } catch (error) {
          setMessage(t("configFailed"));
        } finally {
          setBusy(false);
        }
      }
      return h(
        "div",
        { className: "afp-configuration" },
        h("p", { className: "afp-muted" }, t("configHelp")),
        loaded ? h(
          "div",
          null,
          h("div", { className: "afp-credential-grid" }, ...["accessTokenRef", "usernameRef", "passwordRef", "visionKeyRef"].map((key) => h(
            "div",
            { key, className: "afp-credential-field" },
            h(
              "label",
              null,
              h("span", null, t(key), h("small", null, loaded.config[key])),
              h(Input, {
                type: "password",
                autoComplete: "new-password",
                value: secrets[key] ?? "",
                "aria-label": t(key),
                onChange: (event) => setSecrets((current) => ({ ...current, [key]: event.target.value }))
              })
            ),
            h(
              "div",
              { className: "afp-credential-actions" },
              h(Button, { variant: "outline", size: "sm", disabled: busy || !secrets[key], onClick: () => {
                void credential(key);
              } }, t("saveCredential")),
              key === "accessTokenRef" ? h(Button, {
                variant: "outline",
                size: "sm",
                disabled: busy || !String(secrets.usernameRef ?? "").trim() || !String(secrets.passwordRef ?? ""),
                "aria-busy": acquiringToken,
                icon: acquiringToken ? h(StateDot, { state: "ongoing", size: 14 }) : null,
                onClick: () => {
                  void acquireToken();
                }
              }, acquiringToken ? t("acquiringToken") : t("acquireToken")) : null
            )
          ))),
          h("div", { className: "afp-config-fields" }, ...["visionBaseUrl", "visionModel", "targetPerCategory", "batchSize", "maxBatches", "concurrency"].map((key) => h(
            "label",
            { key },
            t(key),
            h(Input, { value: ["string", "number"].includes(typeof draft[key]) ? draft[key] : "", type: typeof loaded.config[key] === "number" ? "number" : "text", "aria-label": t(key), onChange: (event) => {
              const next = { ...draft, [key]: typeof loaded.config[key] === "number" ? Number(event.target.value) : event.target.value };
              setDraft(next);
              setText(JSON.stringify(next, null, 2));
            } })
          ))),
          h(
            "details",
            { className: "afp-advanced" },
            h("summary", null, t("advanced")),
            h("label", { className: "afp-deployment" }, t("deployment"), h("textarea", {
              className: "afp-input",
              rows: 10,
              value: text,
              "aria-label": t("deployment"),
              onChange: (event) => {
                setText(event.target.value);
                try {
                  const value = JSON.parse(event.target.value);
                  if (value && typeof value === "object" && !Array.isArray(value)) setDraft(value);
                } catch (error) {
                }
              },
              spellCheck: false
            }))
          ),
          h("p", { className: "afp-muted" }, t("deploymentHelp")),
          h("div", { className: "afp-config-footer" }, h(Button, { variant: "primary", size: "sm", disabled: busy, onClick: () => {
            void save();
          } }, t("saveConfig")))
        ) : !message ? h("p", null, t("loading")) : null,
        message ? h("p", { role: "status" }, message) : null
      );
    };
  }

  // src/client/locales/zh.json
  var zh_default = {
    title: "AFP \u56FE\u7247\u7B56\u5C55",
    scope: "\u4EFB\u52A1\u5C5E\u4E8E\u5F53\u524D profile\uFF1B\u5207\u6362\u4F1A\u8BDD\u6216\u5173\u95ED\u9875\u9762\u4E0D\u4F1A\u505C\u6B62\u4EFB\u52A1\u3002",
    reload: "\u5237\u65B0\u72B6\u6001",
    credentials: "\u51ED\u636E\u4E0E\u90E8\u7F72\u914D\u7F6E",
    credentialHelp: "\u5BC6\u94A5\u5355\u72EC\u5199\u5165 DSH \u51ED\u636E\u670D\u52A1\uFF0C\u4E0D\u56DE\u8BFB\u6216\u5199\u5165\u63D2\u4EF6\u914D\u7F6E\uFF1B\u7559\u7A7A\u4FDD\u7559\u5DF2\u6709\u503C\u3002",
    configured: "\u5DF2\u914D\u7F6E",
    missing: "\u5C1A\u672A\u914D\u7F6E",
    vision: "\u89C6\u89C9\u6A21\u578B\u4E0E\u63A5\u53E3",
    features: "\u529F\u80FD\u914D\u7F6E",
    script: "\u811A\u672C\u4E0E\u5DE5\u5177",
    skill: "\u6280\u80FD",
    ui: "\u9875\u9762\u5165\u53E3",
    selected: "\u5DF2\u9009\u62E9",
    unselected: "\u672A\u9009\u62E9",
    running: "\u8FD0\u884C\u4E2D",
    stopped: "\u672A\u8FD0\u884C",
    curation: "\u641C\u7D22\u4E0E\u5237\u65B0",
    query: "\u8F93\u5165\u56FE\u7247\u641C\u7D22\u4E3B\u9898",
    search: "\u89C4\u5212\u641C\u7D22",
    collections: "\u8BFB\u53D6\u6536\u85CF\u5939",
    refresh: "\u5F00\u59CB\u89C6\u89C9 dry-run",
    resume: "\u7EED\u8DD1",
    runId: "\u5237\u65B0\u8BB0\u5F55 runId",
    operation: "\u5199\u5165\u6A21\u5F0F",
    append: "\u8FFD\u52A0",
    replace: "\u66FF\u6362",
    clear: "\u6E05\u7A7A",
    preview: "\u9884\u89C8\u5199\u5165\u8BA1\u5212",
    confirmation: "\u786E\u8BA4\u8FDC\u7AEF\u5199\u5165",
    writeWarning: "\u786E\u8BA4\u540E\u4F1A\u4FEE\u6539\u4E0B\u9762\u8FD9\u4E9B\u7CBE\u786E\u7684\u79C1\u6709\u6536\u85CF\u5939\u3002\u5931\u8D25\u6216\u53D6\u6D88\u53EF\u80FD\u7559\u4E0B\u90E8\u5206\u5199\u5165\uFF0C\u4E0D\u4F1A\u81EA\u52A8\u56DE\u6EDA\u6216\u91CD\u8BD5\u3002",
    target: "\u76EE\u6807\u6536\u85CF\u5939",
    remove: "\u5220\u9664\u6570\u91CF",
    add: "\u65B0\u589E\u6570\u91CF",
    expires: "\u786E\u8BA4\u6709\u6548\u671F",
    confirm: "\u786E\u8BA4\u6267\u884C\u5199\u5165",
    dismiss: "\u653E\u5F03\u8BA1\u5212",
    tasks: "\u4EFB\u52A1\u4E0E\u62A5\u544A",
    cancel: "\u53D6\u6D88\u4EFB\u52A1",
    noTasks: "\u6682\u65E0\u8FD0\u884C\u4E2D\u7684\u4EFB\u52A1\uFF1B\u5DF2\u6709\u62A5\u544A\u548C\u68C0\u67E5\u70B9\u4F1A\u4FDD\u7559\u3002",
    result: "\u64CD\u4F5C\u7ED3\u679C",
    loading: "\u6B63\u5728\u8BFB\u53D6\u2026",
    error: "\u64CD\u4F5C\u5931\u8D25",
    write: "\u8FDC\u7AEF\u5199\u5165",
    animals: "\u52A8\u7269",
    food: "\u98DF\u7269",
    landscape: "\u98CE\u666F",
    "movie-poster": "\u7535\u5F71\u6D77\u62A5",
    "celestial-body-wallpaper": "\u5929\u4F53\u58C1\u7EB8",
    accessTokenRef: "AFP \u8BBF\u95EE\u4EE4\u724C",
    usernameRef: "AFP \u7528\u6237\u540D",
    passwordRef: "AFP \u5BC6\u7801",
    visionKeyRef: "\u89C6\u89C9\u6A21\u578B\u5BC6\u94A5",
    visionBaseUrl: "\u89C6\u89C9\u63A5\u53E3\u5730\u5740",
    visionModel: "\u89C6\u89C9\u6A21\u578B\u540D\u79F0",
    targetPerCategory: "\u6BCF\u7C7B\u76EE\u6807\u6570\u91CF",
    batchSize: "\u6BCF\u6279\u56FE\u7247\u6570\u91CF",
    maxBatches: "\u6700\u5927\u6279\u6B21\u6570",
    concurrency: "\u5E76\u884C\u4EFB\u52A1\u6570",
    advanced: "\u9AD8\u7EA7\u914D\u7F6E",
    configHelp: "\u5BC6\u94A5\u5355\u72EC\u5199\u5165 DSH \u51ED\u636E\u670D\u52A1\uFF0C\u4E0D\u56DE\u8BFB\u6216\u5199\u5165\u63D2\u4EF6\u914D\u7F6E\uFF1B\u7559\u7A7A\u4FDD\u7559\u5DF2\u6709\u503C\u3002",
    deployment: "\u90E8\u7F72\u914D\u7F6E\uFF08JSON\uFF0C\u4E0D\u542B\u5BC6\u94A5\uFF09",
    deploymentHelp: "\u914D\u7F6E\u63A5\u53E3\u3001\u6A21\u578B\u3001\u51ED\u636E\u5F15\u7528\u540D\u4E0E\u6267\u884C\u9884\u7B97\uFF1B\u4FDD\u5B58\u4F1A\u91CD\u65B0\u52A0\u8F7D\u63D2\u4EF6\u5E76\u53D6\u6D88\u6B63\u5728\u8FD0\u884C\u7684\u4EFB\u52A1\u3002\u529F\u80FD\u5F00\u5173\u4ECD\u7531 config.json \u7BA1\u7406\u3002",
    saveCredential: "\u4FDD\u5B58\u51ED\u636E",
    acquireToken: "\u83B7\u53D6\u4EE4\u724C",
    acquiringToken: "\u6B63\u5728\u83B7\u53D6",
    tokenAcquiring: "\u6B63\u5728\u83B7\u53D6\u8BBF\u95EE\u4EE4\u724C\uFF0C\u8BF7\u7A0D\u5019\u2026",
    credentialSaved: "\u51ED\u636E\u5DF2\u4FDD\u5B58\u3002",
    tokenAcquired: "\u5DF2\u83B7\u53D6\u8BBF\u95EE\u4EE4\u724C\u5E76\u5B89\u5168\u4FDD\u5B58\u5728 DSH \u51ED\u636E\u670D\u52A1\u4E2D\u3002",
    tokenCredentialsRequired: "\u8BF7\u5148\u586B\u5199 AFP \u7528\u6237\u540D\u548C\u5BC6\u7801\uFF0C\u518D\u83B7\u53D6\u4EE4\u724C\u3002",
    tokenAcquireFailed: "\u83B7\u53D6\u4EE4\u724C\u5931\u8D25\u3002\u8BF7\u68C0\u67E5\u586B\u5199\u7684 AFP \u7528\u6237\u540D\u3001\u5BC6\u7801\u548C\u7F51\u7EDC\u8FDE\u63A5\u3002",
    saveConfig: "\u4FDD\u5B58\u90E8\u7F72\u914D\u7F6E",
    configSaved: "\u90E8\u7F72\u914D\u7F6E\u5DF2\u4FDD\u5B58\uFF0C\u63D2\u4EF6\u6B63\u5728\u91CD\u65B0\u52A0\u8F7D\u3002",
    configFailed: "\u4FDD\u5B58\u6216\u8BFB\u53D6\u5931\u8D25\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00\u5E76\u68C0\u67E5\u914D\u7F6E\u5B57\u6BB5\u3001\u51ED\u636E\u6743\u9650\u53CA profile \u72B6\u6001\u3002"
  };

  // src/client/locales/en.json
  var en_default = {
    title: "AFP photo curation",
    scope: "Tasks belong to this profile and continue when you switch sessions or close the view.",
    reload: "Reload status",
    credentials: "Credentials and deployment",
    credentialHelp: "Secrets go separately to DSH credentials, never read back or stored in plugin config. Blank fields preserve existing values.",
    configured: "Configured",
    missing: "Not configured",
    vision: "Vision model and endpoint",
    features: "Feature configuration",
    script: "Scripts and tools",
    skill: "Skills",
    ui: "Page entries",
    selected: "Selected",
    unselected: "Unselected",
    running: "Running",
    stopped: "Not running",
    curation: "Search and refresh",
    query: "Photo search topic",
    search: "Plan search",
    collections: "Read collections",
    refresh: "Start visual dry-run",
    resume: "Resume",
    runId: "Refresh runId",
    operation: "Write mode",
    append: "Append",
    replace: "Replace",
    clear: "Clear",
    preview: "Preview write plan",
    confirmation: "Confirm remote write",
    writeWarning: "Confirmation changes the exact private collections below. Failure or cancellation may leave partial writes; no automatic rollback or retry.",
    target: "Target collection",
    remove: "Removed",
    add: "Added",
    expires: "Confirmation expires",
    confirm: "Confirm remote write",
    dismiss: "Discard plan",
    tasks: "Tasks and reports",
    cancel: "Cancel task",
    noTasks: "No tasks running. Saved reports and checkpoints remain available.",
    result: "Result",
    loading: "Reading\u2026",
    error: "Operation failed",
    write: "Remote write",
    animals: "Animals",
    food: "Food",
    landscape: "Landscape",
    "movie-poster": "Movie posters",
    "celestial-body-wallpaper": "Celestial wallpapers",
    accessTokenRef: "AFP access token",
    usernameRef: "AFP username",
    passwordRef: "AFP password",
    visionKeyRef: "Vision API key",
    visionBaseUrl: "Vision endpoint",
    visionModel: "Vision model",
    targetPerCategory: "Target per category",
    batchSize: "Images per batch",
    maxBatches: "Maximum batches",
    concurrency: "Concurrent tasks",
    advanced: "Advanced settings",
    configHelp: "Secrets go separately to DSH credentials, never read back or stored in plugin config. Blank fields preserve existing values.",
    deployment: "Deployment settings (JSON, no secrets)",
    deploymentHelp: "Edit endpoints, models, credential references and budgets. Saving reloads the plugin and cancels active tasks. Feature selections stay in config.json.",
    saveCredential: "Save credential",
    acquireToken: "Get token",
    acquiringToken: "Getting token",
    tokenAcquiring: "Getting access token\u2026",
    credentialSaved: "Credential saved.",
    tokenAcquired: "The access token was acquired and securely stored in DSH credentials.",
    tokenCredentialsRequired: "Enter the AFP username and password before getting a token.",
    tokenAcquireFailed: "Could not get an access token. Check the entered AFP username, password and network connection.",
    saveConfig: "Save deployment settings",
    configSaved: "Deployment settings saved. The plugin is reloading.",
    configFailed: "Read or save failed. Reopen and check settings, credential permissions and profile status."
  };

  // assets/workbench.css
  var workbench_default = ".afp-workbench { max-width: 1000px; margin: 0 auto; padding: 28px; overflow: auto; height: 100%; box-sizing: border-box; color: var(--dsw-alias-label-primary); font-size: 13px; }\n.afp-workbench h2 { font-size: 22px; margin: 0 0 8px; }\n.afp-workbench h3 { font-size: 15px; margin: 0 0 16px; }\n.afp-workbench h4 { font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 16px 0 8px; }\n.afp-header, .afp-line { display: flex; align-items: center; justify-content: space-between; gap: 20px; }\n.afp-section { margin-top: 26px; padding: 18px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px; background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 45%, transparent); backdrop-filter: blur(8px); }\n.afp-line { padding: 9px 0; }\n.afp-muted { color: var(--dsw-alias-label-secondary); margin: 6px 0; font-size: 12px; }\n.afp-toolbar, .afp-categories { display: flex; gap: 10px; flex-wrap: wrap; margin: 12px 0; align-items: center; }\n.afp-categories label { display: inline-flex; gap: 6px; align-items: center; }\n.afp-button, .afp-input { color: inherit; font: inherit; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); padding: 8px 12px; }\n.afp-button { cursor: pointer; }\n.afp-button:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-3); }\n.afp-button:disabled { cursor: default; opacity: .45; }\n.afp-input { min-width: 160px; flex: 1; }\n.afp-workbench :focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 3px; }\n.afp-configuration textarea:focus-visible, .afp-configuration summary:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }\n.afp-report { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 360px; overflow: auto; font-size: 12px; }\n.afp-error { color: var(--dsw-alias-state-error-primary); }\n.afp-confirm { border-color: var(--dsw-alias-state-business-primary); }\n.afp-deployment { display: grid; gap: 8px; margin-top: 20px; }\n.afp-deployment textarea { width: 100%; box-sizing: border-box; font-family: var(--ds-font-family-code); font-size: 12px; }\n.afp-configuration .afp-toolbar { align-items: flex-end; }\n.afp-configuration label { display: grid; gap: 6px; flex: 1; min-width: 0; }\n.afp-configuration { font-size: 13px; line-height: 1.5; }\n.afp-credential-grid { display: grid; gap: 14px; margin: 18px 0 24px; }\n.afp-credential-field { display: flex; align-items: flex-end; gap: 10px; }\n.afp-credential-actions { display: flex; gap: 8px; align-items: center; flex: none; }\n.afp-credential-field small { margin-left: 8px; color: var(--dsw-alias-label-tertiary); font-size: 11px; overflow-wrap: anywhere; }\n.afp-config-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }\n.afp-config-fields > label:first-child, .afp-config-fields > label:nth-child(2) { grid-column: 1 / -1; }\n.afp-advanced { margin: 20px 0 12px; }\n.afp-advanced summary { cursor: pointer; color: var(--dsw-alias-label-secondary); }\n.afp-config-footer { display: flex; justify-content: flex-end; margin-top: 16px; }\n.afp-workbench table { border-collapse: collapse; width: 100%; text-align: left; }\n.afp-workbench th, .afp-workbench td { padding: 8px; }\n.afp-workbench summary { cursor: pointer; padding: 10px 0; overflow-wrap: anywhere; }\n@media (max-width: 620px) { .afp-workbench { padding: 16px; } .afp-section { padding: 12px; } .afp-line { gap: 12px; } .afp-config-fields { grid-template-columns: minmax(0, 1fr); } }\n";

  // src/client/afp-client-entry.js
  window.__ModuleLoader__.load({ id: "dsh-plugin-afp", factory(require2) {
    const React = require2("react"), { Switch, Input, Button, StateDot } = require2("@deepseek-ai/dsh-client-ui-primitives");
    return { inject: ["slots", "locale", "remote", "remote.pluginManager", "remote.credentials", "layout", "uiConversation"], apply(ctx) {
      const namespace = "afpWorkbench", panel = "afp-workbench";
      ctx.effect(() => ctx.locale.register(namespace, { en: en_default, zh: zh_default }), "AFP locale");
      const t = ctx.locale.bind(namespace), store = createAfpClientStore(ctx);
      const Workbench = createWorkbench(React, Switch, ctx, t, store);
      const ConfigurationForm = createConfigurationForm(React, { Input, Button, StateDot }, ctx, t);
      for (const row of ["afp-read", "afp-refresh", "afp-write"]) ctx.slots.inject("plugins.row.config", () => ctx.slots.register({
        name: "plugins.row.config",
        key: `dsh-plugin-afp#${row}`,
        locale: namespace
      }, ConfigurationForm));
      ctx.effect(() => {
        const style = document.createElement("style");
        style.textContent = workbench_default;
        document.head.append(style);
        return () => style.remove();
      }, "AFP styles");
      ctx.effect(() => () => store.dispose(), "AFP store");
      const registrations = /* @__PURE__ */ new Map();
      function icon({ size = 18 }) {
        return React.createElement(
          "svg",
          { width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
          React.createElement("rect", { x: 3, y: 4, width: 18, height: 16, rx: 4, stroke: "currentColor", strokeWidth: 1.6 }),
          React.createElement("circle", { cx: 8.5, cy: 9, r: 1.5, fill: "currentColor" }),
          React.createElement("path", { d: "m5 17 5-5 3 3 3-4 3 6", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" })
        );
      }
      function sync() {
        const flags = store.getSnapshot().status?.features ?? [];
        for (const feature of ["ui-settings", "ui-panel", "ui-conversation"]) {
          if (flags.includes(feature) === registrations.has(feature)) continue;
          if (!flags.includes(feature)) {
            registrations.get(feature)();
            registrations.delete(feature);
            continue;
          }
          const options = { id: panel, order: 45, label: () => t("title"), locale: namespace };
          const child = ctx.plugin({ name: `afp-${feature}`, apply(child2) {
            if (feature === "ui-settings") child2.slots.inject("settings.section", () => child2.slots.register({ ...options, name: "settings.section" }, Workbench));
            if (feature === "ui-panel") {
              child2.slots.inject("main", () => child2.slots.register({ name: "main", key: panel, locale: namespace }, Workbench));
              child2.slots.inject("sidebar.panellist", () => child2.slots.register({ ...options, name: "sidebar.panellist" }, icon));
            }
            if (feature === "ui-conversation") {
              child2.effect(() => child2.uiConversation.views.register({ target: panel, create: () => ({ empty: null, replace: () => null, apply: () => null }) }), "AFP view definition");
              child2.slots.inject("conversation.view", () => child2.slots.register({ ...options, name: "conversation.view" }, Workbench));
            }
          } });
          registrations.set(feature, () => {
            if (feature === "ui-panel" && ctx.layout.panelInfo.getSnapshot().activePanelId === panel) ctx.layout.selectPanel(null);
            void child.dispose();
          });
        }
      }
      ctx.effect(() => {
        const unsubscribe = store.subscribe(sync);
        const changed = ctx.remote.$on("plugin-manager/changed", () => {
          void store.reload();
        });
        const reset = ctx.on("connection/reset", () => {
          void store.reload();
        });
        let timer, stopped = false;
        const poll = async () => {
          await store.reload();
          if (!stopped) timer = setTimeout(poll, store.getSnapshot().status?.pollIntervalMs ?? 2e3);
        };
        void poll();
        return () => {
          stopped = true;
          clearTimeout(timer);
          unsubscribe();
          changed();
          reset();
          for (const remove of registrations.values()) remove();
          registrations.clear();
        };
      }, "AFP entry lifecycle");
    } };
  } });
})();
