"use strict";
(() => {
  // src/client/afp-preview-media.js
  var rasterTypes = /* @__PURE__ */ new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
  function previewSource(path, baseURI) {
    if (typeof path !== "string" || !path.startsWith("api/afp/preview?photoId=")) return null;
    try {
      const url = new URL(path, baseURI), expected = new URL("api/afp/preview", baseURI);
      if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.hash || [...url.searchParams.keys()].some((key) => key !== "photoId") || url.searchParams.getAll("photoId").length !== 1 || !url.searchParams.get("photoId")) return null;
      return url.href;
    } catch (error) {
      return null;
    }
  }
  async function readPreviewMedia(src, signal, fetchImpl = globalThis.fetch) {
    const response = await fetchImpl(src, { signal, credentials: "same-origin" });
    if (!response.ok) {
      let diagnostic;
      try {
        diagnostic = await response.json();
      } catch (error) {
      }
      const blocked = diagnostic?.code === "preview-host-blocked" && typeof diagnostic.host === "string" && /^[a-z0-9.-]+$/.test(diagnostic.host);
      throw Object.assign(new Error("Preview unavailable"), { code: blocked ? "preview-host-blocked" : "preview-unavailable", host: blocked ? diagnostic.host : null });
    }
    const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (!rasterTypes.has(type)) throw new Error("Preview unavailable");
    return response.blob();
  }

  // src/client/afp-workbench-gallery.js
  function createAfpGallery(React, UI, icons, t, store) {
    const h = React.createElement;
    const { Button, Tag, Modal, Tooltip } = UI;
    function ImagePreview({ photo, large = false, retry = false, open }) {
      const [attempt, setAttempt] = React.useState(0);
      const [media, setMedia] = React.useState({ src: "", status: "loading", host: null });
      const frame = React.useRef(null);
      const currentLease = React.useRef(null);
      const src = previewSource(photo?.previewPath, document.baseURI);
      const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      const readEnabled = snapshot.status?.features?.includes("read");
      React.useEffect(() => {
        const controller = new AbortController();
        let lease, observer, started = false;
        setMedia({ src: "", status: src && readEnabled ? "loading" : "error", host: null });
        const start = async () => {
          if (started || !src || !readEnabled) return;
          started = true;
          observer?.disconnect();
          try {
            lease = await store.acquirePreview(src, controller.signal, { refresh: attempt > 0 });
            if (controller.signal.aborted) return;
            currentLease.current = lease;
            setMedia({ src: lease.url, status: "decoding", host: null });
          } catch (error) {
            if (!controller.signal.aborted) setMedia({ src: "", status: "error", host: error.host ?? null });
          }
        };
        if (!large && typeof IntersectionObserver === "function" && frame.current) {
          observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) void start();
          });
          observer.observe(frame.current);
        } else void start();
        return () => {
          controller.abort();
          observer?.disconnect();
          lease?.release();
          if (currentLease.current === lease) currentLease.current = null;
        };
      }, [src, attempt, large, readEnabled, snapshot.previewGeneration]);
      const ready = media.status === "ready";
      if (media.status === "error" || !src) return h("div", { ref: frame, className: "afp-wb-preview-container" }, h(
        "div",
        { className: `afp-wb-image-fallback${large ? " afp-wb-image-fallback-large" : ""}` },
        h("span", { "aria-hidden": true }, "\u25A7"),
        h("span", null, t("previewUnavailable")),
        media.host ? h("span", { className: "afp-wb-preview-diagnostic" }, t("previewHostBlocked").replace("{host}", media.host)) : null,
        retry ? h(Button, { variant: "ghost", size: "sm", onClick: (event) => {
          event.stopPropagation();
          setAttempt((value) => value + 1);
        } }, t("retryPreview")) : null
      ));
      const image = h(
        "div",
        { className: `afp-wb-image-stage${large ? " is-large" : ""}${ready ? " is-ready" : ""}`, "aria-busy": !ready },
        !ready ? h("span", { className: "afp-skeleton afp-wb-image-skeleton", role: "status", "aria-label": t("loading") }) : null,
        media.src ? h("img", {
          className: large ? "afp-wb-photo-large" : "afp-wb-photo",
          src: media.src,
          alt: open ? "" : photo.title || t("photoDetails"),
          onLoad: () => setMedia((current) => current.src === media.src ? { ...current, status: "ready" } : current),
          decoding: "async",
          onError: () => {
            store.invalidatePreview(src, media.src);
            if (currentLease.current?.url === media.src) currentLease.current.release();
            setMedia((current) => current.src === media.src ? { ...current, status: "error" } : current);
          }
        }) : null
      );
      return h("div", { ref: frame, className: "afp-wb-preview-container" }, open ? h("button", { type: "button", className: "afp-wb-image-button", onClick: open, "aria-label": `${t("openPhoto")} ${photo.title ?? photo.id}` }, image) : image);
    }
    function PhotoSkeleton() {
      return h("div", { className: "afp-wb-skeleton-tile", "aria-hidden": true }, h("span"), h("span"), h("span"));
    }
    function PhotoGrid({ items = [], selectedPhotos = {}, report = false, sourceCollectionId, loading = false }) {
      if (!items.length && !loading) return h("p", { className: "afp-wb-empty" }, t(report ? "noReportItems" : "noPhotos"));
      return h("div", { className: "afp-wb-gallery" }, ...items.map((item) => {
        const photo = item;
        const selected2 = Boolean(selectedPhotos[photo.id]);
        const decision = report ? item.requestFailed ? "requestFailed" : item.keep === true ? "kept" : item.keep === false ? "rejected" : "notReviewed" : "";
        const selectLabel = `${t(selected2 ? "removeFromSelection" : "selectPhoto")} ${photo.title || photo.id}`;
        const selectButton = !report ? h(
          Button,
          {
            variant: "ghost",
            size: "sm",
            className: `afp-wb-photo-select${selected2 ? " is-selected" : ""}`,
            "aria-label": selectLabel,
            "aria-pressed": selected2,
            onClick: (event) => {
              event.stopPropagation();
              store.togglePhoto(photo, sourceCollectionId);
            }
          },
          h(
            "span",
            { className: selected2 ? "afp-wb-photo-selected-icon" : "afp-wb-photo-select-icon", "aria-hidden": true },
            icons.IconCheckOutlineRegular ? h(icons.IconCheckOutlineRegular, { size: 12 }) : null
          )
        ) : null;
        return h(
          "article",
          { className: `afp-wb-photo-tile${selected2 ? " is-selected" : ""}`, key: photo.id },
          h(
            "div",
            {
              className: "afp-wb-photo-frame",
              onClick: report ? void 0 : () => store.togglePhoto(photo, sourceCollectionId),
              onContextMenu: (event) => {
                event.preventDefault();
                void store.openPhoto(photo);
              }
            },
            h(ImagePreview, { photo, retry: true, open: report ? () => {
              void store.openPhoto(photo);
            } : void 0 }),
            selectButton && Tooltip ? h(Tooltip, { label: t(selected2 ? "removeFromSelection" : "selectPhoto"), side: "top", portal: true, maxWidth: 180 }, selectButton) : selectButton
          ),
          h(
            "button",
            { type: "button", className: "afp-wb-photo-open", onClick: () => {
              void store.openPhoto(photo);
            }, "aria-label": `${t("openPhoto")} ${photo.title}` },
            h("span", { className: "afp-wb-photo-title" }, photo.title || photo.id)
          ),
          h(
            "div",
            { className: "afp-wb-photo-meta" },
            h("span", null, (photo.provider ?? "AFP").replace(/^afpprovider:/i, "")),
            report ? h("span", null, t(item.category)) : null,
            report && decision ? h(Tag, { tone: decision === "kept" ? "success" : decision === "requestFailed" ? "warning" : "neutral" }, t(decision)) : null
          ),
          report && item.confidence != null ? h("p", { className: "afp-wb-subtle" }, `${t("modelConfidence")}: ${item.confidence}`) : null,
          report && item.reason ? h("p", { className: "afp-wb-subtle afp-wb-photo-reason" }, item.reason) : null
        );
      }), loading ? Array.from({ length: 6 }, (_, index) => h(PhotoSkeleton, { key: `loading-${index}` })) : null);
    }
    function DetailPane({ photo, loading, error, onClose, sourceCollectionId }) {
      const [previewOpen, setPreviewOpen] = React.useState(false);
      React.useEffect(() => setPreviewOpen(false), [photo?.id]);
      if (!photo) return null;
      return h(
        "aside",
        { className: "afp-wb-detail", "aria-label": t("photoDetails") },
        h(
          "div",
          { className: "afp-wb-detail-head" },
          h("h3", null, t("photoDetails")),
          h(Button, { variant: "ghost", size: "sm", className: "afp-wb-close-button", "aria-label": t("closeDetails"), onClick: onClose }, icons.IconCloseOutlineRegular ? h(icons.IconCloseOutlineRegular, { size: 14 }) : t("close"))
        ),
        h(ImagePreview, { key: photo.id, photo, large: true, retry: true, open: () => setPreviewOpen(true) }),
        loading ? h("div", { className: "afp-wb-detail-skeleton", role: "status", "aria-label": t("loading") }, h("span", { className: "afp-skeleton" }), h("span", { className: "afp-skeleton" })) : null,
        error ? h("p", { className: "afp-wb-error", role: "alert" }, t("regionReadFailed")) : null,
        h("h4", { className: "afp-wb-detail-title" }, photo.title || photo.id),
        photo.provider ? h("p", { className: "afp-wb-subtle" }, `${t("provider")}: ${photo.provider.replace(/^afpprovider:/i, "")}`) : null,
        h(
          "details",
          { className: "afp-wb-photo-identifiers" },
          h("summary", null, t("photoIdentifiers")),
          h("dl", null, h("dt", null, t("photoId")), h("dd", null, photo.id), photo.guid ? h(React.Fragment, null, h("dt", null, t("photoGuid")), h("dd", null, photo.guid)) : null)
        ),
        photo.caption ? h("p", { className: "afp-wb-caption" }, photo.caption) : null,
        photo.keywords?.length ? h("div", { className: "afp-wb-keywords" }, ...photo.keywords.map((keyword) => h(Tag, { key: keyword, tone: "neutral" }, keyword))) : null,
        photo.reason ? h("p", { className: "afp-wb-subtle" }, photo.reason) : null,
        photo.confidence != null ? h("p", { className: "afp-wb-subtle" }, `${t("modelConfidence")}: ${photo.confidence}`) : null,
        photo.requestFailed ? h(Tag, { tone: "warning" }, t("requestFailed")) : photo.keep === true ? h(Tag, { tone: "success" }, t("kept")) : photo.keep === false ? h(Tag, { tone: "neutral" }, t("rejected")) : null,
        h(Button, { variant: selected(photo.id) ? "outline" : "primary", size: "sm", onClick: () => selected(photo.id) ? store.removePhoto(photo.id) : store.selectPhoto(photo, sourceCollectionId) }, t(selected(photo.id) ? "removeFromSelection" : "selectPhoto")),
        Modal ? h(
          Modal,
          {
            open: previewOpen,
            onClose: () => setPreviewOpen(false),
            title: photo.title || t("photoDetails"),
            closeLabel: t("close"),
            className: "afp-wb-preview-modal",
            contentClassName: "afp-wb-preview-modal-content"
          },
          previewOpen ? h(ImagePreview, { key: photo.id, photo, large: true, retry: true }) : null
        ) : null
      );
    }
    function selected(id) {
      return Boolean(store.getSnapshot().selectedPhotos[id]);
    }
    function SelectionPane({ photos, onOpen }) {
      return h(
        "aside",
        { className: "afp-wb-detail afp-wb-selection", "aria-label": t("selectionList") },
        h("div", { className: "afp-wb-detail-head" }, h("h3", null, t("selectionList"))),
        !photos.length ? h("p", { className: "afp-wb-empty" }, t("selectionEmpty")) : h("div", { className: "afp-wb-selection-list" }, ...photos.map((photo) => {
          const label = `${t("removePhoto")} ${photo.title || photo.id}`;
          const removeButton = h(
            Button,
            {
              variant: "ghost",
              size: "sm",
              className: "afp-wb-selection-remove",
              "aria-label": label,
              onClick: () => store.removePhoto(photo.id)
            },
            icons.IconCloseOutlineRegular ? h(icons.IconCloseOutlineRegular, { size: 14 }) : t("remove")
          );
          return h(
            "div",
            { className: "afp-wb-selection-item", key: photo.id },
            h(ImagePreview, { photo, retry: true, open: () => onOpen(photo) }),
            h("button", { type: "button", className: "afp-wb-selection-open", onClick: () => onOpen(photo) }, h("span", null, photo.title || photo.id)),
            Tooltip ? h(Tooltip, { label: t("removeFromSelection"), side: "top", align: "end", portal: true, maxWidth: 180 }, removeButton) : removeButton
          );
        })),
        photos.length ? h(Button, { variant: "ghost", size: "sm", onClick: () => store.clearSelection() }, t("clearSelection")) : null
      );
    }
    return { ImagePreview, PhotoGrid, PhotoSkeleton, DetailPane, SelectionPane };
  }

  // src/client/afp-workbench-tasks.js
  function createAfpTaskPanels(React, UI, t, store, gallery, Selector, icons = {}) {
    const h = React.createElement;
    const { Button, Checkbox, Input, Tag, StateDot, Tooltip } = UI;
    const categoryKeys = ["animals", "food", "landscape", "movie-poster", "celestial-body-wallpaper"];
    function HistorySkeleton() {
      return h(
        "div",
        { className: "afp-wb-history-skeleton", role: "status", "aria-label": t("loading") },
        ...Array.from({ length: 3 }, (_, index) => h(
          "div",
          { key: index, "aria-hidden": true },
          h("span", { className: "afp-skeleton" }),
          h("span", { className: "afp-skeleton" }),
          h("span", { className: "afp-skeleton" })
        ))
      );
    }
    function ReloadButton({ loading, onClick }) {
      const Icon = icons.IconRefreshOutlineRegular;
      const button = h(
        Button,
        {
          variant: "ghost",
          size: "sm",
          disabled: loading,
          "aria-busy": loading,
          "aria-label": t("reload"),
          onClick,
          className: "afp-wb-icon-action"
        },
        loading ? h(StateDot, { state: "ongoing", size: 14 }) : Icon ? h(Icon, { size: 16 }) : t("reload")
      );
      return Tooltip ? h(Tooltip, { label: t("reload"), portal: true, maxWidth: 180 }, button) : button;
    }
    function error(region) {
      return region?.error ? h(
        "div",
        { className: "afp-wb-error-row", role: "alert" },
        h("span", null, t("regionReadFailed")),
        h(Button, { variant: "ghost", size: "sm", onClick: region.retry }, t("retry"))
      ) : null;
    }
    function RunHistory({ state }) {
      const region = state.regions.runs, rows = region.data?.items ?? [];
      return h(
        "section",
        { className: "afp-wb-section" },
        h(
          "div",
          { className: "afp-wb-section-heading" },
          h("h3", null, t("runHistory")),
          h(ReloadButton, { loading: region.loading, onClick: () => {
            void store.loadHistory("runs");
          } })
        ),
        error({ ...region, retry: () => store.loadHistory("runs") }),
        !rows.length && !region.loading && !region.error ? h("p", { className: "afp-wb-empty" }, t("noRunHistory")) : null,
        !rows.length && region.loading ? h(HistorySkeleton) : null,
        h("div", { className: "afp-wb-history-list" }, ...rows.map((item) => h(
          "button",
          {
            type: "button",
            className: "afp-wb-history-row",
            key: item.id,
            onClick: () => {
              void store.openRun(item.id);
            }
          },
          h("span", { className: "afp-wb-history-title" }, item.createdAt ? new Date(item.createdAt).toLocaleString() : t("dateUnknown")),
          h(Tag, { tone: item.status === "ready" || item.status === "paused" ? "success" : item.status === "failed" ? "warning" : "neutral" }, t(`runStatus_${item.status}`)),
          h("span", { className: "afp-wb-subtle" }, (item.run?.categories ?? []).map((row) => `${t(row.category)} ${row.kept}/${row.target}`).join(" \xB7 "))
        ))),
        region.data?.hasMore ? h(Button, { variant: "outline", size: "sm", disabled: region.loading, onClick: () => {
          void store.loadHistory("runs", { more: true });
        } }, t("loadMore")) : null
      );
    }
    function LiveTasks({ state }) {
      const tasks = state.status?.tasks ?? [];
      const downloads = state.status?.downloads ?? [];
      const activeTaskIds = new Set(tasks.map((task) => task.taskId));
      const downloadRows = downloads.map((record) => h(
        "details",
        { className: "afp-wb-download-task", key: record.id },
        h(
          "summary",
          null,
          h("span", { className: "afp-wb-download-task-title" }, t("downloadTask")),
          h(Tag, { tone: record.status === "completed" ? "success" : ["failed", "interrupted", "partial"].includes(record.status) ? "warning" : "neutral" }, t(`downloadStatus_${record.status}`)),
          h("span", { className: "afp-wb-subtle" }, `${record.completed}/${record.total} \xB7 ${t("failedCount")} ${record.failed} \xB7 ${t("pendingCount")} ${record.pending}`)
        ),
        record.updatedAt ? h("p", { className: "afp-wb-subtle" }, new Date(record.updatedAt).toLocaleString()) : null,
        h("div", { className: "afp-wb-download-task-files" }, ...(record.items ?? []).slice(0, 8).map((item) => h(
          "p",
          { key: item.photoId },
          h("span", null, item.fileName || item.title || item.photoId),
          h(Tag, { tone: item.status === "completed" ? "success" : ["failed", "pending"].includes(item.status) ? "warning" : "neutral" }, t(`downloadStatus_${item.status}`)),
          item.errorCode === "purchase-pending" ? h("span", { className: "afp-wb-subtle" }, t("purchasePending")) : item.errorCode === "host-stopped" ? h("span", { className: "afp-wb-subtle" }, t("hostStopped")) : null
        ))),
        record.taskId && activeTaskIds.has(record.taskId) ? h(Button, {
          variant: "ghost",
          size: "sm",
          disabled: state.busy,
          onClick: () => {
            void store.invoke("cancel", { taskId: record.taskId });
          }
        }, t("cancel")) : null
      ));
      return h(
        "section",
        { className: "afp-wb-section" },
        h(
          "div",
          { className: "afp-wb-section-heading" },
          h("h3", null, t("liveTasks")),
          h(Tag, { tone: "neutral" }, String(tasks.length))
        ),
        tasks.length ? h("div", { className: "afp-wb-live-list" }, ...tasks.map((task) => {
          let progress = null;
          try {
            progress = task.progress ? JSON.parse(task.progress) : null;
          } catch (error2) {
          }
          return h(
            "article",
            { className: "afp-wb-live-row", key: task.taskId },
            h(
              "div",
              null,
              h("p", { className: "afp-wb-history-title" }, t(task.feature === "write" ? "writeTask" : "refreshTask")),
              progress && typeof progress.category === "string" ? h("p", { className: "afp-wb-subtle" }, `${t(progress.category)} \xB7 ${t("keptCount")} ${progress.kept}/${progress.target} \xB7 ${t("batch")} ${progress.batch}`) : null
            ),
            h(Button, { variant: "ghost", size: "sm", disabled: state.busy, onClick: () => {
              void store.invoke("cancel", { taskId: task.taskId });
            } }, t("cancel"))
          );
        })) : null,
        downloads.length ? h("div", { className: "afp-wb-download-tasks" }, h("h4", null, t("downloadTasks")), ...downloadRows) : null,
        !tasks.length && !downloads.length ? h("p", { className: "afp-wb-subtle" }, t("noLiveTasks")) : null
      );
    }
    function RefreshForm({ state, onOpenAccount }) {
      const active2 = state.status?.features?.includes("refresh");
      const credentials = state.account?.credentials ?? {};
      const credentialsReady = Boolean(credentials.accessTokenRef?.configured || credentials.usernameRef?.configured && credentials.passwordRef?.configured);
      const visionReady = Boolean(state.account?.visionConfigured && credentials.visionKeyRef?.configured);
      const ready = active2 && credentialsReady && visionReady;
      const validNumbers = Number.isInteger(state.targetPerCategory) && state.targetPerCategory >= 1 && state.targetPerCategory <= 1e3 && Number.isFinite(state.threshold) && state.threshold >= 0.8 && state.threshold <= 1;
      const validationId = React.useId();
      const setCategories = (category) => store.set({ selected: state.selected.includes(category) ? state.selected.filter((item) => item !== category) : [...state.selected, category] });
      const submit = (event) => {
        event.preventDefault();
        if (!ready || state.busy || !state.selected.length || !validNumbers) return;
        void store.invoke("refresh", { categories: state.selected, targetPerCategory: state.targetPerCategory, threshold: state.threshold });
      };
      return h(
        "section",
        { className: "afp-wb-section afp-wb-task-setup" },
        h(
          "div",
          { className: "afp-wb-section-heading" },
          h("h3", null, t("newRefresh")),
          h(Tag, { tone: "quiet" }, String(state.selected.length))
        ),
        !ready ? h(
          "div",
          { className: "afp-wb-prerequisite" },
          h("p", null, t("refreshPrerequisite")),
          h(Button, { variant: "outline", size: "sm", onClick: onOpenAccount }, t("openAccountSettings"))
        ) : null,
        h(
          "form",
          { className: "afp-wb-refresh-form", onSubmit: submit },
          h(
            "fieldset",
            { disabled: !ready || state.busy },
            h("legend", null, t("categories")),
            h("div", { className: "afp-wb-categories" }, ...categoryKeys.map((category) => h(
              "div",
              { key: category, className: "afp-wb-category-option", "data-selected": state.selected.includes(category) },
              h(Checkbox, { checked: state.selected.includes(category), label: t(category), onChange: () => setCategories(category) })
            ))),
            h(
              "div",
              { className: "afp-wb-number-fields" },
              h("label", null, t("targetPerCategory"), h(Input, {
                className: "afp-wb-input",
                type: "number",
                min: 1,
                max: 1e3,
                step: 1,
                "aria-label": t("targetPerCategory"),
                "aria-describedby": ready && !validNumbers ? validationId : void 0,
                "aria-invalid": ready && (!Number.isInteger(state.targetPerCategory) || state.targetPerCategory < 1 || state.targetPerCategory > 1e3),
                value: state.targetPerCategory ?? "",
                onChange: (event) => store.set({ targetPerCategory: Number(event.target.value) })
              })),
              h("label", null, t("threshold"), h(Input, {
                className: "afp-wb-input",
                type: "number",
                min: 0.8,
                max: 1,
                step: 0.01,
                "aria-label": t("threshold"),
                "aria-describedby": ready && !validNumbers ? validationId : void 0,
                "aria-invalid": ready && (!Number.isFinite(state.threshold) || state.threshold < 0.8 || state.threshold > 1),
                value: state.threshold ?? "",
                onChange: (event) => store.set({ threshold: Number(event.target.value) })
              }))
            ),
            ready && !validNumbers ? h("p", { id: validationId, className: "afp-wb-field-error", role: "status" }, t("refreshInvalidValues")) : null,
            h(Button, {
              variant: "primary",
              type: "submit",
              "aria-busy": state.busy,
              disabled: !ready || state.busy || !state.selected.length || !validNumbers,
              icon: state.busy ? h(StateDot, { state: "ongoing", size: 14 }) : null
            }, t("startRefresh"))
          )
        ),
        h(
          "details",
          { className: "afp-wb-resume" },
          h("summary", null, t("resumeRun")),
          h(
            "div",
            { className: "afp-wb-resume-row" },
            h(Input, { className: "afp-wb-input", value: state.runId, "aria-label": t("resumeRunId"), placeholder: t("resumeRunId"), onChange: (event) => store.set({ runId: event.target.value }) }),
            h(Button, { variant: "outline", disabled: !active2 || !state.runId.trim() || state.busy, onClick: () => {
              void store.invoke("refresh", { runId: state.runId.trim() });
            } }, t("resumeRun"))
          )
        )
      );
    }
    function ReportPanel({ state, onOpenChanges }) {
      const region = state.regions.run, report = region.data, items = report?.items ?? [];
      const runSummary = report?.run;
      const canPlan = ["ready", "paused"].includes(runSummary?.status) && !runSummary?.pendingBatch;
      return h(
        "section",
        { className: "afp-wb-section afp-wb-report" },
        h(
          "div",
          { className: "afp-wb-section-heading" },
          h("h3", null, t("runReport")),
          h(Button, { variant: "ghost", size: "sm", onClick: () => store.set({ runId: "", regions: { ...state.regions, run: { data: null, loading: false, error: "" } } }) }, t("closeReport"))
        ),
        runSummary ? h("div", { className: "afp-wb-report-summary" }, ...runSummary.categories.map((row) => h(
          "p",
          { key: row.category },
          `${t(row.category)} \xB7 ${t("reviewedCount")} ${row.reviewed} \xB7 ${t("keptCount")} ${row.kept}/${row.target} \xB7 ${t("requestFailures")}: ${row.requestFailures}`
        ))) : null,
        h(
          "div",
          { className: "afp-wb-toolbar" },
          h(
            "div",
            { className: "afp-wb-field" },
            h("span", null, t("categoryFilter")),
            h(Selector, {
              value: state.reportCategory,
              label: t("categoryFilter"),
              options: [{ value: "", label: t("allCategories") }, ...categoryKeys.filter((category) => runSummary?.categories.some((row) => row.category === category)).map((value) => ({ value, label: t(value) }))],
              onChange: (category) => {
                void store.openRun(state.runId, { category, decision: state.reportFilter });
              }
            })
          ),
          h(
            "div",
            { className: "afp-wb-field" },
            h("span", null, t("decisionFilter")),
            h(Selector, {
              value: state.reportFilter,
              label: t("decisionFilter"),
              options: ["all", "kept", "rejected", "failed"].map((value) => ({ value, label: t(`filter_${value}`) })),
              onChange: (decision) => {
                void store.openRun(state.runId, { category: state.reportCategory, decision });
              }
            })
          )
        ),
        region.error ? h(
          "div",
          { role: "alert", className: "afp-wb-error-row" },
          t("regionReadFailed"),
          h(Button, { variant: "ghost", size: "sm", onClick: () => {
            void store.openRun(state.runId, { category: state.reportCategory, decision: state.reportFilter });
          } }, t("retry"))
        ) : null,
        runSummary?.categories.every((row) => row.reviewed === 0) ? h("p", { className: "afp-wb-empty" }, t("noReviewedItems")) : h(
          "div",
          { className: `afp-wb-gallery-layout${state.detail ? " is-with-aside" : ""}` },
          h(
            "div",
            { className: "afp-wb-gallery-wrap" },
            h(gallery.PhotoGrid, { items, report: true }),
            region.data?.hasMore ? h(Button, { variant: "outline", disabled: region.loading, onClick: () => {
              void store.openRun(state.runId, { category: state.reportCategory, decision: state.reportFilter, more: true });
            } }, t("loadMore")) : null
          ),
          state.detail && state.tab === "tasks" ? h(gallery.DetailPane, { photo: state.detail, loading: state.regions.detail.loading, error: state.regions.detail.error, onClose: () => store.closePhoto() }) : null
        ),
        canPlan ? h(Button, { variant: "primary", disabled: !state.status?.features?.includes("write"), onClick: () => onOpenChanges(runSummary.runId) }, t("previewWrite")) : null
      );
    }
    function TasksPanel({ state, onOpenAccount, onOpenChanges }) {
      const report = state.regions.run;
      const pendingReport = state.runId && !report.data && (report.loading || report.error);
      return h(
        "div",
        { className: "afp-wb-panel-content afp-wb-task-layout" },
        h(RefreshForm, { state, onOpenAccount }),
        h(
          "div",
          { className: "afp-wb-task-results" },
          h(LiveTasks, { state }),
          state.runId && state.regions.run.data ? h(ReportPanel, { state, onOpenChanges }) : null,
          pendingReport ? h(
            "section",
            { className: "afp-wb-section", "aria-busy": report.loading },
            h(
              "div",
              { className: "afp-wb-section-heading" },
              h("h3", null, t("runReport")),
              h(Button, { variant: "ghost", size: "sm", onClick: () => store.set({ runId: "", regions: { ...state.regions, run: { data: null, loading: false, error: "" } } }) }, t("closeReport"))
            ),
            report.loading ? h(HistorySkeleton) : error({ ...report, retry: () => store.openRun(state.runId, { category: state.reportCategory, decision: state.reportFilter }) })
          ) : null,
          !report.data && !pendingReport ? h(RunHistory, { state }) : null
        )
      );
    }
    function PlanCard({ state }) {
      const plan = state.plan;
      if (!plan) return null;
      const expired = !Number.isFinite(plan.expiresAt) || plan.expiresAt <= Date.now();
      return h(
        "section",
        { className: "afp-wb-section afp-wb-plan", "aria-label": t("confirmation") },
        h(
          "div",
          { className: "afp-wb-section-heading" },
          h("h3", null, t("writePreview")),
          h(Tag, { tone: expired ? "warning" : "neutral" }, expired ? t("expired") : t("previewReady"))
        ),
        h("p", { className: "afp-wb-warning" }, t("writeWarning")),
        h("div", { className: "afp-wb-plan-list" }, ...plan.categories.map((item) => h(
          "div",
          { className: "afp-wb-plan-row", key: item.category },
          h("strong", null, t(item.category)),
          h("span", null, item.selectionName),
          h("span", null, `${t("existingCount")}: ${item.existing ?? "\u2014"}`),
          h("span", null, `${t("remove")}: ${item.remove}`),
          h("span", null, `${t("add")}: ${item.add}`),
          item.create ? h(Tag, { tone: "neutral" }, t("createTarget")) : null
        ))),
        plan.expiresAt ? h("p", { className: "afp-wb-subtle" }, `${t("expires")}: ${new Date(plan.expiresAt).toLocaleString()}`) : null,
        h(Checkbox, { checked: state.confirmChecked, label: t("confirmRead"), disabled: expired || state.busy, onChange: (checked) => store.set({ confirmChecked: checked }) }),
        h(
          "div",
          { className: "afp-wb-actions" },
          h(Button, { variant: "primary", disabled: expired || state.busy || !state.confirmChecked || !state.status?.features?.includes("write"), onClick: () => {
            void store.confirmPlan();
          } }, t("confirm")),
          h(Button, { variant: "ghost", disabled: state.busy, onClick: () => store.set({ plan: null, planFingerprint: "", confirmChecked: false }) }, t("dismiss"))
        )
      );
    }
    function ChangesPanel({ state }) {
      const runs = state.regions.runs.data?.items?.filter((item) => item.kind === "run") ?? [];
      const plans = state.regions.plans.data?.items ?? [];
      const writeEnabled = state.status?.features?.includes("write");
      const selectedRun = runs.find((item) => item.id === state.runId);
      const settled = selectedRun && ["ready", "paused"].includes(selectedRun.status) && !selectedRun.run?.pendingBatch;
      const eligible = state.operation === "clear" || settled;
      const generate = () => {
        void store.previewPlan();
      };
      const planRows = plans.map((item) => h(
        "details",
        { className: "afp-wb-plan-history", key: item.id },
        h(
          "summary",
          null,
          icons.IconChevronDownOutlineRegular ? h(icons.IconChevronDownOutlineRegular, { size: 14, className: "afp-wb-plan-chevron" }) : null,
          h("span", { className: "afp-wb-history-title" }, t(item.plan.operation)),
          h("span", { className: "afp-wb-subtle afp-wb-plan-date" }, item.createdAt ? new Date(item.createdAt).toLocaleString() : t("dateUnknown")),
          h(Tag, { tone: item.status === "completed" ? "success" : item.status === "failed" ? "warning" : "neutral" }, t(`planStatus_${item.status}`))
        ),
        h("p", { className: "afp-wb-subtle" }, `${t("changeId")} \xB7 ${item.id}`),
        h("ul", { className: "afp-wb-plan-results" }, ...item.plan.targets.map((target) => {
          const actual = item.plan.result?.categories?.find((row) => row.category === target.category);
          return h("li", { key: target.category }, `${t(target.category)} \xB7 ${t("removedCount")} ${actual?.removed ?? "\u2014"} \xB7 ${t("addedCount")} ${actual?.added ?? "\u2014"} \xB7 ${t(`planStatus_${actual?.status ?? item.status}`)}`);
        }))
      ));
      return h(
        "div",
        { className: "afp-wb-panel-content afp-wb-change-layout" },
        h(
          "section",
          { className: "afp-wb-section afp-wb-change-form" },
          h("h3", null, t("changePreview")),
          !writeEnabled ? h("p", { className: "afp-wb-subtle" }, t("writeDisabled")) : null,
          h(
            "div",
            { className: "afp-wb-change-fields" },
            h(
              "div",
              { className: "afp-wb-field" },
              h("span", null, t("sourceReport")),
              h(Selector, {
                value: state.runId,
                label: t("sourceReport"),
                disabled: state.busy || state.operation === "clear",
                options: [{ value: "", label: t("chooseReport") }, ...runs.map((item) => ({
                  value: item.id,
                  label: `${item.createdAt ? new Date(item.createdAt).toLocaleDateString() : t("dateUnknown")} \xB7 ${t(`runStatus_${item.status}`)} \xB7 ${item.id.slice(0, 8)}`
                }))],
                onChange: (runId) => store.set({ runId })
              })
            ),
            h(
              "div",
              { className: "afp-wb-field" },
              h("span", null, t("operation")),
              h(Selector, {
                value: state.operation,
                label: t("operation"),
                disabled: !writeEnabled || state.busy,
                options: ["append", "replace", "clear"].map((value) => ({ value, label: t(value) })),
                onChange: (operation) => store.set({ operation })
              })
            )
          ),
          h(
            "fieldset",
            { disabled: !writeEnabled || state.busy },
            h("legend", null, t("categories")),
            h("div", { className: "afp-wb-categories" }, ...categoryKeys.map((category) => h(
              "div",
              { key: category, className: "afp-wb-category-option", "data-selected": state.selected.includes(category) },
              h(Checkbox, { checked: state.selected.includes(category), label: t(category), onChange: () => store.set({ selected: state.selected.includes(category) ? state.selected.filter((item) => item !== category) : [...state.selected, category] }) })
            ))),
            h(
              "div",
              { className: "afp-wb-change-footer" },
              h("p", { className: "afp-wb-subtle" }, t(state.operation === "clear" ? "clearPreviewHint" : !settled ? "settledRunRequired" : "previewOnlyHint")),
              h(Button, {
                variant: "primary",
                "aria-busy": state.busy,
                icon: state.busy ? h(StateDot, { state: "ongoing", size: 14 }) : null,
                disabled: !writeEnabled || !eligible || !state.selected.length || state.operation !== "clear" && !state.runId || state.busy,
                onClick: generate
              }, t("previewWrite"))
            )
          )
        ),
        h(
          "div",
          { className: "afp-wb-change-results" },
          h(PlanCard, { state }),
          h(
            "section",
            { className: "afp-wb-section" },
            h(
              "div",
              { className: "afp-wb-section-heading" },
              h("h3", null, t("planHistory")),
              h(ReloadButton, { loading: state.regions.plans.loading, onClick: () => {
                void store.loadHistory("plans");
              } })
            ),
            state.regions.plans.error ? error({ ...state.regions.plans, retry: () => store.loadHistory("plans") }) : null,
            !plans.length && state.regions.plans.loading ? h(HistorySkeleton) : null,
            !plans.length && !state.regions.plans.loading && !state.regions.plans.error ? h("p", { className: "afp-wb-empty" }, t("noPlanHistory")) : null,
            ...planRows,
            state.regions.plans.data?.hasMore ? h(Button, { variant: "outline", size: "sm", disabled: state.regions.plans.loading, onClick: () => {
              void store.loadHistory("plans", { more: true });
            } }, t("loadMore")) : null
          )
        )
      );
    }
    return { TasksPanel, ChangesPanel };
  }

  // src/client/afp-selector.js
  function createAfpSelector(React, { Menu, Button }, Chevron) {
    const h = React.createElement;
    return function AfpSelector({ value, options, label, onChange, disabled = false, className = "", displayValue }) {
      const [open, setOpen] = React.useState(false);
      const chosen = options.find((option) => option.value === value);
      return h("div", { className: `afp-wb-selector ${className}` }, h(Menu, {
        open: open && !disabled,
        onClose: () => setOpen(false),
        portal: true,
        compact: true,
        autoFocus: true,
        selectedId: chosen ? String(options.indexOf(chosen)) : void 0,
        items: options.map((option, index) => ({ id: String(index), label: option.label, disabled: option.disabled })),
        onSelect: (id) => {
          const option = options[Number(id)];
          if (option && !option.disabled) onChange(option.value);
          setOpen(false);
        },
        anchor: h(
          Button,
          {
            variant: "outline",
            size: "sm",
            className: "afp-wb-selector-trigger",
            disabled,
            "aria-label": label,
            "aria-haspopup": "menu",
            "aria-expanded": open && !disabled,
            onClick: () => setOpen((current) => !current)
          },
          h("span", { className: "afp-wb-selector-value" }, displayValue ?? chosen?.label ?? label),
          Chevron ? h(Chevron, { size: 14 }) : null
        )
      }));
    };
  }

  // src/shared/afp-download-filenames.js
  function cleanFilenamePart(value, limit = 100) {
    return String(value ?? "").normalize("NFKC").replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_").trim().slice(0, limit).replace(/[. ]+$/g, "");
  }
  function downloadFilenameBase(source, prefix = "", suffix = "") {
    const before = cleanFilenamePart(prefix, 80), after = cleanFilenamePart(suffix, 80);
    const delivered = source.fileName ? String(source.fileName).split(/[\\/]/).at(-1) : null;
    const original = delivered ? delivered.replace(/\.[^.]+$/, "") : source.guid || source.photoId;
    const stem = cleanFilenamePart(original, 200 - before.length - after.length) || "AFP-image";
    const base = `${before}${stem}${after}`.replace(/[. ]+$/g, "");
    return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base) ? `_${base}` : base;
  }

  // src/client/afp-download-qualities.js
  function rank(left, right) {
    return (right.width ?? 0) * (right.height ?? 0) - (left.width ?? 0) * (left.height ?? 0) || (right.sizeInBytes ?? 0) - (left.sizeInBytes ?? 0) || left.purchaseCost - right.purchaseCost;
  }
  function chooseDownloadRenditions(photos, preference, writeEnabled) {
    return Object.fromEntries(photos.flatMap((photo) => {
      if (photo.errorCode) return [];
      const eligible = (photo.renditions ?? []).filter((row) => row.available && (row.purchaseCost === 0 || writeEnabled) && (preference.kind !== "free" || row.purchaseCost === 0) && (preference.kind !== "quality" || row.quality === preference.quality));
      const chosen = eligible.sort(rank)[0];
      return chosen ? [[photo.id, chosen.id]] : [];
    }));
  }
  function downloadQualityChoices(photos, writeEnabled) {
    const qualities = [...new Set(photos.flatMap((photo) => (photo.renditions ?? []).map((row) => row.quality).filter(Boolean)))];
    return [
      { id: "free", labelKey: "bulkQualityFree", preference: { kind: "free" } },
      { id: "highest", labelKey: "bulkQualityHighest", preference: { kind: "highest" } },
      ...qualities.map((quality, index) => ({ id: `quality:${index}`, quality, preference: { kind: "quality", quality } }))
    ].map((choice) => {
      const matched = Object.keys(chooseDownloadRenditions(photos, choice.preference, writeEnabled)).length;
      return { ...choice, matched, total: photos.length, disabled: !matched };
    });
  }

  // src/client/afp-download-dialog.js
  var errorKeys = {
    "invalid-request": "downloadServiceOutdated",
    "response-too-large": "downloadResponseTooLarge",
    "download-auth-unavailable": "downloadAuthFailed",
    "download-photo-unavailable": "downloadPhotoFailed",
    "download-no-renditions": "downloadNoRenditions",
    "download-balance-unavailable": "downloadBalanceRequired",
    "download-insufficient-credit": "downloadInsufficientCredit",
    "download-picker-unavailable": "downloadPickerUnavailable",
    "download-directory-expired": "downloadDirectoryExpired",
    "download-options-expired": "downloadOptionsExpired",
    "download-confirmation-expired": "downloadConfirmationExpired",
    "download-write-disabled": "downloadPaidDisabled",
    "download-account-changed": "downloadAccountChanged"
  };
  var stageKeys = { options: "downloadOptionsFailed", directory: "downloadDirectoryFailed", prepare: "downloadPrepareFailed", confirm: "downloadConfirmFailed" };
  function bytes(value) {
    if (!Number.isFinite(value)) return "";
    return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`;
  }
  function createAfpDownloadDialog(React, UI, icons, t, store, ImagePreview) {
    const h = React.createElement, { Modal, Button, Input, Tag, Checkbox, StateDot, Menu, Tooltip } = UI;
    const Selector = createAfpSelector(React, UI, icons.IconChevronDownOutlineRegular);
    const icon = (name, size = 16) => icons[name] ? h(icons[name], { size }) : null;
    const spinner = () => h(StateDot, { state: "ongoing", size: 14 });
    const tooltip = (label, child) => Tooltip ? h(Tooltip, { label, side: "top", portal: true }, child) : child;
    return function DownloadDialog({ state, onAccount, onTasks }) {
      const [prefix, setPrefix] = React.useState(""), [suffix, setSuffix] = React.useState(""), [confirmed, setConfirmed] = React.useState(false);
      const [bulkOpen, setBulkOpen] = React.useState(false);
      const open = state.collectionAction === "download";
      React.useEffect(() => {
        if (open) {
          setPrefix("");
          setSuffix("");
          setConfirmed(false);
          setBulkOpen(false);
          void store.loadDownloadOptions({ reset: true });
        }
      }, [open]);
      React.useEffect(() => setConfirmed(false), [state.downloadPlan?.confirmation]);
      React.useEffect(() => {
        if (!open || state.downloadOptionsLoading || state.downloadBusy) setBulkOpen(false);
      }, [open, state.downloadOptionsLoading, state.downloadBusy]);
      if (!Modal || !open) return null;
      const close = () => {
        if (!state.downloadBusy) store.set({ collectionAction: null, downloadPlan: null, downloadQuoteChanged: false });
      };
      const navigate = (callback) => {
        close();
        callback?.();
      };
      const photos = Object.values(state.selectedPhotos), options = state.downloadOptions?.photos ?? [];
      const writeEnabled = state.status?.features?.includes("write");
      const chosen = options.flatMap((photo) => {
        const rendition = photo.renditions?.find((row) => row.id === state.downloadSelected[photo.id] && row.available);
        return rendition ? [{ photo, rendition }] : [];
      });
      const ready = Boolean(state.downloadOptions) && !state.downloadOptionsLoading && state.downloadErrorStage !== "options";
      const hasQuote = ready && chosen.length > 0;
      const plan = state.downloadPlan, balance = state.downloadOptions?.creditBalance;
      const total = plan?.totalCost ?? chosen.reduce((sum, item) => sum + item.rendition.purchaseCost, 0);
      const paidBlocked = total > 0 && (!writeEnabled || balance == null || total > balance);
      const disabled = state.downloadBusy || !ready || !state.downloadDirectory || !chosen.length || paidBlocked;
      const retry = () => {
        void store.loadDownloadOptions();
      };
      const bulkChoices = downloadQualityChoices(photos.map((photo) => options.find((row) => row.id === photo.id) ?? { id: photo.id, renditions: [] }), Boolean(writeEnabled));
      const bulkDisabled = state.downloadBusy || !ready || !bulkChoices.some((choice) => !choice.disabled);
      const uniformQuality = chosen.length === photos.length && new Set(chosen.map((item) => item.rendition.quality)).size === 1 ? chosen[0]?.rendition.quality : null;
      const bulkItems = bulkChoices.map((choice) => ({
        id: choice.id,
        disabled: choice.disabled,
        label: h(
          "span",
          { className: "afp-wb-download-bulk-choice" },
          h("span", null, choice.labelKey ? t(choice.labelKey) : choice.quality),
          h(Tag, { tone: "quiet" }, `${choice.matched}/${choice.total}`)
        )
      }));
      if (bulkItems.length > 2) bulkItems.splice(2, 0, { type: "separator", id: "qualities" });
      const bulkMenu = h(Menu, {
        open: bulkOpen && !bulkDisabled,
        portal: true,
        compact: true,
        autoFocus: true,
        selectedId: bulkChoices.find((choice) => choice.quality === uniformQuality)?.id,
        items: bulkItems,
        onClose: () => setBulkOpen(false),
        onSelect: (id) => {
          const choice = bulkChoices.find((row) => row.id === id);
          if (choice && !choice.disabled && !bulkDisabled) store.applyDownloadQuality(choice.preference);
          setBulkOpen(false);
        },
        anchor: tooltip(t("bulkQualityTitle"), h(Button, {
          variant: "ghost",
          size: "sm",
          className: "afp-wb-download-toolbar-button",
          disabled: bulkDisabled,
          "aria-label": t("bulkQualityTitle"),
          "aria-haspopup": "menu",
          "aria-expanded": bulkOpen && !bulkDisabled,
          onClick: () => setBulkOpen((value) => !value)
        }, icon("IconSlidersTwoOutlineRegular", 18)))
      });
      const changeName = (setter, value) => {
        setter(value);
        store.set({ downloadPlan: null });
      };
      const warning = state.downloadQuoteChanged ? t("downloadQuoteChanged") : total > 0 && !writeEnabled ? t("downloadPaidDisabled") : total > 0 && balance == null ? t("downloadBalanceRequired") : total > 0 && total > balance ? t("downloadInsufficientCredit") : "";
      const error = state.downloadError ? t(errorKeys[state.downloadError] ?? stageKeys[state.downloadErrorStage] ?? "downloadOptionsFailed") : "";
      const errorRetry = state.downloadErrorStage === "options" || state.downloadError === "download-options-expired";
      const rows = photos.map((source) => {
        const photo = options.find((row) => row.id === source.id);
        const selected = photo?.renditions?.find((row) => row.id === state.downloadSelected[source.id]);
        const failed = photo?.errorCode;
        const choices = [{ value: "", label: t("chooseRendition"), disabled: true }, ...(photo?.renditions ?? []).map((row) => ({
          value: row.id,
          disabled: !row.available || row.purchaseCost > 0 && !writeEnabled,
          label: [
            row.quality,
            row.width && row.height ? `${row.width}\xD7${row.height}` : "",
            bytes(row.sizeInBytes),
            row.purchaseCost ? `${row.purchaseCost} ${t("credits")}` : t(row.alreadyAvailable ? "alreadyAvailable" : "free")
          ].filter(Boolean).join(" \xB7 ")
        }))];
        const title = source.title || photo?.title || source.id;
        return h(
          "div",
          { key: source.id, className: "afp-wb-download-item", role: "listitem" },
          h("div", { className: "afp-wb-download-thumbnail", "aria-hidden": true }, h(ImagePreview, { photo: source, retry: false })),
          h(
            "div",
            { className: "afp-wb-download-item-name" },
            tooltip(title, h("span", { className: "afp-wb-download-item-title" }, title)),
            h(
              "div",
              { className: "afp-wb-download-item-meta" },
              selected ? h("span", null, [selected.width && selected.height ? `${selected.width} \xD7 ${selected.height}` : "", bytes(selected.sizeInBytes)].filter(Boolean).join(" \xB7 ")) : null,
              selected ? h(Tag, { tone: selected.purchaseCost ? "warning" : "success" }, selected.purchaseCost ? `${selected.purchaseCost} ${t("credits")}` : t("free")) : null
            )
          ),
          h("div", { className: "afp-wb-download-item-quality" }, failed ? h("span", { className: "afp-wb-download-item-error" }, t(errorKeys[failed] ?? "downloadPhotoFailed")) : h(Selector, {
            value: state.downloadSelected[source.id] ?? "",
            displayValue: selected?.quality ?? t("chooseRendition"),
            label: `${t("downloadQuality")} \xB7 ${title}`,
            options: choices,
            disabled: state.downloadBusy || !ready || !photo,
            onChange: (value) => store.setDownloadRendition(source.id, value)
          }))
        );
      });
      const notice = (message, tone, children, role = "status") => h(
        "div",
        { className: `afp-wb-download-notice is-${tone}`, role },
        h("span", null, message),
        children
      );
      const previews = chosen.slice(0, 3).map(({ photo }) => h("code", { key: photo.id }, downloadFilenameBase({ guid: photo.guid, photoId: photo.id }, prefix, suffix)));
      return h(
        Modal,
        { open, headless: true, title: t("downloadSelectionTitle"), onClose: close, className: "afp-wb-action-modal afp-wb-download-modal" },
        h(
          "header",
          { className: "afp-wb-download-header" },
          h("span", { className: "afp-wb-download-heading-icon", "aria-hidden": true }, icon("IconDownloadOutlineRegular", 20)),
          h("div", null, h("h2", null, t("downloadSelectionTitle")), h("p", null, t("downloadDefaultQuality"))),
          h(Tag, null, t("photoCountShort").replace("{count}", String(photos.length))),
          h(Button, { variant: "ghost", size: "sm", className: "afp-wb-download-close afp-wb-close-button", "aria-label": t("close"), disabled: state.downloadBusy, onClick: close }, icon("IconCloseOutlineRegular", 14))
        ),
        h(
          "div",
          { className: "afp-wb-download-scroll" },
          h(
            "section",
            { className: "afp-wb-download-quality-section", "aria-label": t("downloadQuality") },
            h(
              "div",
              { className: "afp-wb-download-section-title" },
              h(
                "div",
                { className: "afp-wb-download-section-label" },
                h("h3", null, t("downloadQuality")),
                state.downloadBulkResult ? tooltip(
                  state.downloadBulkResult.matched < state.downloadBulkResult.total ? t("bulkQualityUnmatched") : t("bulkQualityTitle"),
                  h(
                    "span",
                    { role: "status", className: "afp-wb-download-bulk-result" },
                    h(
                      Tag,
                      { tone: state.downloadBulkResult.matched < state.downloadBulkResult.total ? "warning" : "quiet" },
                      t("bulkQualityApplied").replace("{count}", String(state.downloadBulkResult.matched)).replace("{total}", String(state.downloadBulkResult.total))
                    )
                  )
                ) : null
              ),
              h(
                "div",
                { className: "afp-wb-download-toolbar-actions" },
                bulkMenu,
                tooltip(t("refreshOptions"), h(Button, {
                  variant: "ghost",
                  size: "sm",
                  className: "afp-wb-download-toolbar-button",
                  "aria-label": t("refreshOptions"),
                  disabled: state.downloadBusy || state.downloadOptionsLoading,
                  onClick: retry,
                  "aria-busy": state.downloadOptionsLoading
                }, state.downloadOptionsLoading ? spinner() : icon("IconRefreshOutlineRegular", 18)))
              )
            ),
            error ? notice(error, "error", h(
              "div",
              { className: "afp-wb-download-notice-actions" },
              errorRetry ? h(Button, {
                variant: "outline",
                size: "sm",
                disabled: state.downloadBusy || state.downloadOptionsLoading,
                "aria-busy": state.downloadOptionsLoading,
                icon: state.downloadOptionsLoading ? spinner() : null,
                onClick: retry
              }, t("retry")) : null,
              state.downloadError === "download-auth-unavailable" ? h(Button, { variant: "ghost", size: "sm", onClick: () => navigate(onAccount) }, t("openAccountSettings")) : null,
              state.downloadErrorStage === "confirm" ? h(Button, { variant: "ghost", size: "sm", onClick: () => navigate(onTasks) }, t("viewDownloadTasks")) : null
            ), "alert") : null,
            state.downloadOptionsLoading && !options.length ? h(
              "div",
              { className: "afp-wb-download-skeleton", role: "status", "aria-busy": true, "aria-label": t("loading") },
              ...photos.slice(0, 6).map((photo) => h(
                "div",
                { className: "afp-wb-download-skeleton-row", key: photo.id, "aria-hidden": true },
                h("span", { className: "afp-skeleton afp-wb-download-skeleton-thumb" }),
                h(
                  "div",
                  null,
                  h("span", { className: "afp-skeleton" }),
                  h("span", { className: "afp-skeleton" }),
                  h("span", { className: "afp-skeleton afp-wb-download-skeleton-select" })
                )
              ))
            ) : options.length ? h("div", { className: "afp-wb-download-items", role: "list", "aria-label": t("downloadQuality"), "aria-busy": state.downloadOptionsLoading }, ...rows) : null,
            ready && chosen.length < photos.length ? notice(
              t("downloadAvailableCount").replace("{count}", String(chosen.length)).replace("{total}", String(photos.length)),
              "warning",
              h(Button, { variant: "ghost", size: "sm", disabled: state.downloadBusy, onClick: retry }, t("retry"))
            ) : null,
            ready && !writeEnabled && options.some((photo) => photo.renditions?.some((row) => row.purchaseCost > 0)) ? h("p", { className: "afp-wb-download-hint" }, t("downloadPaidDisabled")) : null
          ),
          h(
            "div",
            { className: "afp-wb-download-settings" },
            h(
              "section",
              { className: "afp-wb-download-save-section", "aria-label": t("saveLocation") },
              h(
                "div",
                { className: "afp-wb-download-location" },
                h("span", { "aria-hidden": true }, icon("IconFolderCloseRegular", 18)),
                h("div", null, h("span", { className: "afp-wb-download-label" }, t("saveLocation")), h("strong", null, state.downloadDirectory?.label ?? t("downloadChooseLocation"))),
                h(Button, {
                  variant: "outline",
                  size: "sm",
                  "data-modal-autofocus": true,
                  disabled: state.downloadBusy,
                  "aria-busy": state.downloadBusyStage === "directory",
                  icon: state.downloadBusyStage === "directory" ? spinner() : null,
                  onClick: () => {
                    void store.pickDownloadDirectory();
                  }
                }, t(state.downloadBusyStage === "directory" ? "choosingDirectory" : state.downloadDirectory ? "changeDirectory" : "chooseDirectory"))
              ),
              h(
                "details",
                { className: "afp-wb-download-filename" },
                h("summary", null, h("span", null, t("filenameCustomization")), h("span", null, t(prefix || suffix ? "downloadCustomizedName" : "downloadOriginalName")), icon("IconChevronDownOutlineRegular", 14)),
                h(
                  "div",
                  { className: "afp-wb-download-filename-fields" },
                  h(
                    "div",
                    { className: "afp-wb-download-naming" },
                    h("label", null, t("filenamePrefix"), h(Input, {
                      className: "afp-wb-input",
                      value: prefix,
                      maxLength: 80,
                      placeholder: t("filenamePrefixExample"),
                      disabled: state.downloadBusy,
                      onChange: (event) => changeName(setPrefix, event.target.value)
                    })),
                    h("label", null, t("filenameSuffix"), h(Input, {
                      className: "afp-wb-input",
                      value: suffix,
                      maxLength: 80,
                      placeholder: t("filenameSuffixExample"),
                      disabled: state.downloadBusy,
                      onChange: (event) => changeName(setSuffix, event.target.value)
                    }))
                  ),
                  previews.length ? h("div", { className: "afp-wb-download-name-preview" }, h("span", null, t("filenamePreview")), ...previews) : null,
                  h("p", { className: "afp-wb-download-hint" }, t("downloadFilenameHint"))
                )
              )
            ),
            warning ? notice(warning, "warning") : null,
            plan ? h(
              "section",
              { className: "afp-wb-download-review", "aria-label": t("downloadConfirmation") },
              h(Tag, { tone: "success" }, t("downloadReviewed").replace("{count}", String(plan.items.length))),
              total > 0 ? h(Checkbox, { checked: confirmed, label: t("confirmDownloadSpend").replace("{credits}", String(total)), disabled: state.downloadBusy, onChange: setConfirmed }) : h("span", null, t("downloadFreeConfirmed"))
            ) : null
          )
        ),
        h(
          "footer",
          { className: "afp-wb-download-footer" },
          h(
            "div",
            { className: "afp-wb-download-total" },
            h("span", null, t("totalCreditCost")),
            h("strong", null, hasQuote ? String(total) : "\u2014"),
            h("span", null, hasQuote ? t("credits") : t("downloadQuotePending")),
            h("small", null, `${t("creditBalance")} \xB7 ${balance ?? t("notAvailable")}`)
          ),
          h(
            "div",
            { className: "afp-wb-download-footer-actions" },
            h(Button, { variant: "ghost", disabled: state.downloadBusy, onClick: close }, t("cancelDownloadSetup")),
            h(
              Button,
              {
                variant: "primary",
                disabled: disabled || Boolean(plan && total > 0 && !confirmed),
                "aria-busy": ["prepare", "confirm"].includes(state.downloadBusyStage),
                icon: ["prepare", "confirm"].includes(state.downloadBusyStage) ? spinner() : icon("IconDownloadOutlineRegular"),
                onClick: () => {
                  void (plan ? store.confirmDownload() : store.prepareDownload({ prefix, suffix }));
                }
              },
              t(state.downloadBusyStage === "prepare" ? "checkingDownload" : state.downloadBusyStage === "confirm" ? "submittingDownload" : plan ? "downloadStartBackground" : "previewDownload")
            )
          )
        )
      );
    };
  }

  // src/client/afp-search-catalog.json
  var afp_search_catalog_default = [
    {
      id: "cat",
      term: "cat",
      categories: [
        "animals"
      ],
      aliases: [
        "\u732B"
      ],
      related: [
        "kitten",
        "ragdoll",
        "maine coon",
        "persian",
        "norwegian forest cat"
      ]
    },
    {
      id: "kitten",
      term: "kitten",
      categories: [
        "animals"
      ],
      aliases: [
        "\u5C0F\u732B",
        "\u5E7C\u732B"
      ],
      related: []
    },
    {
      id: "dog",
      term: "dog",
      categories: [
        "animals"
      ],
      aliases: [
        "\u72D7"
      ],
      related: [
        "puppy"
      ]
    },
    {
      id: "puppy",
      term: "puppy",
      categories: [
        "animals"
      ],
      aliases: [
        "\u5C0F\u72D7",
        "\u5E7C\u72AC"
      ],
      related: []
    },
    {
      id: "rabbit",
      term: "rabbit",
      categories: [
        "animals"
      ],
      aliases: [
        "\u5154\u5B50"
      ],
      related: []
    },
    {
      id: "bunny",
      term: "bunny",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "horse",
      term: "horse",
      categories: [
        "animals"
      ],
      aliases: [
        "\u9A6C"
      ],
      related: []
    },
    {
      id: "pony",
      term: "pony",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "panda",
      term: "panda",
      categories: [
        "animals"
      ],
      aliases: [
        "\u718A\u732B"
      ],
      related: []
    },
    {
      id: "red panda",
      term: "red panda",
      categories: [
        "animals"
      ],
      aliases: [
        "\u5C0F\u718A\u732B"
      ],
      related: []
    },
    {
      id: "dolphin",
      term: "dolphin",
      categories: [
        "animals"
      ],
      aliases: [
        "\u6D77\u8C5A"
      ],
      related: []
    },
    {
      id: "seal",
      term: "seal",
      categories: [
        "animals"
      ],
      aliases: [
        "\u6D77\u8C79"
      ],
      related: []
    },
    {
      id: "penguin",
      term: "penguin",
      categories: [
        "animals"
      ],
      aliases: [
        "\u4F01\u9E45"
      ],
      related: []
    },
    {
      id: "elephant",
      term: "elephant",
      categories: [
        "animals"
      ],
      aliases: [
        "\u5927\u8C61"
      ],
      related: []
    },
    {
      id: "giraffe",
      term: "giraffe",
      categories: [
        "animals"
      ],
      aliases: [
        "\u957F\u9888\u9E7F"
      ],
      related: []
    },
    {
      id: "fox",
      term: "fox",
      categories: [
        "animals"
      ],
      aliases: [
        "\u72D0\u72F8"
      ],
      related: []
    },
    {
      id: "koala",
      term: "koala",
      categories: [
        "animals"
      ],
      aliases: [
        "\u8003\u62C9"
      ],
      related: []
    },
    {
      id: "otter",
      term: "otter",
      categories: [
        "animals"
      ],
      aliases: [
        "\u6C34\u736D"
      ],
      related: []
    },
    {
      id: "lion",
      term: "lion",
      categories: [
        "animals"
      ],
      aliases: [
        "\u72EE\u5B50"
      ],
      related: []
    },
    {
      id: "tiger",
      term: "tiger",
      categories: [
        "animals"
      ],
      aliases: [
        "\u8001\u864E"
      ],
      related: []
    },
    {
      id: "deer",
      term: "deer",
      categories: [
        "animals"
      ],
      aliases: [
        "\u9E7F"
      ],
      related: []
    },
    {
      id: "red fox",
      term: "red fox",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "polar bear",
      term: "polar bear",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "brown bear",
      term: "brown bear",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "capybara",
      term: "capybara",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "meerkat",
      term: "meerkat",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "sloth",
      term: "sloth",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "squirrel",
      term: "squirrel",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "raccoon",
      term: "raccoon",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "quokka",
      term: "quokka",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "fennec fox",
      term: "fennec fox",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "red squirrel",
      term: "red squirrel",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "shiba inu",
      term: "shiba inu",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "golden retriever",
      term: "golden retriever",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "ragdoll",
      term: "ragdoll",
      categories: [
        "animals"
      ],
      aliases: [
        "\u5E03\u5076\u732B"
      ],
      related: []
    },
    {
      id: "maine coon",
      term: "maine coon",
      categories: [
        "animals"
      ],
      aliases: [
        "\u7F05\u56E0\u732B"
      ],
      related: []
    },
    {
      id: "monkey",
      term: "monkey",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "sheep",
      term: "sheep",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "lamb",
      term: "lamb",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "goat",
      term: "goat",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "cow",
      term: "cow",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "cattle",
      term: "cattle",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "hippopotamus",
      term: "hippopotamus",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "hippo",
      term: "hippo",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "rhinoceros",
      term: "rhinoceros",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "rhino",
      term: "rhino",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "zebra",
      term: "zebra",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "whale",
      term: "whale",
      categories: [
        "animals"
      ],
      aliases: [
        "\u9CB8\u9C7C"
      ],
      related: []
    },
    {
      id: "eagle",
      term: "eagle",
      categories: [
        "animals"
      ],
      aliases: [
        "\u9E70"
      ],
      related: []
    },
    {
      id: "hawk",
      term: "hawk",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "owl",
      term: "owl",
      categories: [
        "animals"
      ],
      aliases: [
        "\u732B\u5934\u9E70"
      ],
      related: []
    },
    {
      id: "falcon",
      term: "falcon",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "crane",
      term: "crane",
      categories: [
        "animals"
      ],
      aliases: [
        "\u9E64"
      ],
      related: []
    },
    {
      id: "swan",
      term: "swan",
      categories: [
        "animals"
      ],
      aliases: [
        "\u5929\u9E45"
      ],
      related: []
    },
    {
      id: "flamingo",
      term: "flamingo",
      categories: [
        "animals"
      ],
      aliases: [
        "\u706B\u70C8\u9E1F"
      ],
      related: []
    },
    {
      id: "pelican",
      term: "pelican",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "puffin",
      term: "puffin",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "parrot",
      term: "parrot",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "macaw",
      term: "macaw",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "toucan",
      term: "toucan",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "kingfisher",
      term: "kingfisher",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "gibbon",
      term: "gibbon",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "gorilla",
      term: "gorilla",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "chimpanzee",
      term: "chimpanzee",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "orangutan",
      term: "orangutan",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "robin",
      term: "robin",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "blue jay",
      term: "blue jay",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "goldfinch",
      term: "goldfinch",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "snowy owl",
      term: "snowy owl",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "budgerigar",
      term: "budgerigar",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "budgie",
      term: "budgie",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "lovebird",
      term: "lovebird",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "okapi",
      term: "okapi",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "bongo",
      term: "bongo",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "cheetah",
      term: "cheetah",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "leopard",
      term: "leopard",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "jaguar",
      term: "jaguar",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "lynx",
      term: "lynx",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "bobcat",
      term: "bobcat",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "puma",
      term: "puma",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "cougar",
      term: "cougar",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "serval",
      term: "serval",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "hyena",
      term: "hyena",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "mongoose",
      term: "mongoose",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "aardvark",
      term: "aardvark",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "warthog",
      term: "warthog",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "armadillo",
      term: "armadillo",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "anteater",
      term: "anteater",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "tapir",
      term: "tapir",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "camel",
      term: "camel",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "dromedary",
      term: "dromedary",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "llama",
      term: "llama",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "alpaca",
      term: "alpaca",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "lemur",
      term: "lemur",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "tarsier",
      term: "tarsier",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "marmoset",
      term: "marmoset",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "tamarin",
      term: "tamarin",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "capuchin",
      term: "capuchin",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "chipmunk",
      term: "chipmunk",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "marmot",
      term: "marmot",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "prairie dog",
      term: "prairie dog",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "groundhog",
      term: "groundhog",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "porcupine",
      term: "porcupine",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "beaver",
      term: "beaver",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "mink",
      term: "mink",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "badger",
      term: "badger",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "skunk",
      term: "skunk",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "pika",
      term: "pika",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "vole",
      term: "vole",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "hamster",
      term: "hamster",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "guinea pig",
      term: "guinea pig",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "reindeer",
      term: "reindeer",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "caribou",
      term: "caribou",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "ibex",
      term: "ibex",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "chamois",
      term: "chamois",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "gazelle",
      term: "gazelle",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "kudu",
      term: "kudu",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "springbok",
      term: "springbok",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "yak",
      term: "yak",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "bison",
      term: "bison",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "buffalo",
      term: "buffalo",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "musk ox",
      term: "musk ox",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "wildebeest",
      term: "wildebeest",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "hartebeest",
      term: "hartebeest",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "orca",
      term: "orca",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "walrus",
      term: "walrus",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "manatee",
      term: "manatee",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "dugong",
      term: "dugong",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "albatross",
      term: "albatross",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "tern",
      term: "tern",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "gull",
      term: "gull",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "cormorant",
      term: "cormorant",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "vulture",
      term: "vulture",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "condor",
      term: "condor",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "kestrel",
      term: "kestrel",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "osprey",
      term: "osprey",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "kite",
      term: "kite",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "buzzard",
      term: "buzzard",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "woodpecker",
      term: "woodpecker",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "nightjar",
      term: "nightjar",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "cuckoo",
      term: "cuckoo",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "jay",
      term: "jay",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "magpie",
      term: "magpie",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "parakeet",
      term: "parakeet",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "canary",
      term: "canary",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "finch",
      term: "finch",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "swallow",
      term: "swallow",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "wagtail",
      term: "wagtail",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "warbler",
      term: "warbler",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "ostrich",
      term: "ostrich",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "emu",
      term: "emu",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "cassowary",
      term: "cassowary",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "kiwi",
      term: "kiwi",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "rhea",
      term: "rhea",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "peacock",
      term: "peacock",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "pheasant",
      term: "pheasant",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "turkey",
      term: "turkey",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "quail",
      term: "quail",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "grouse",
      term: "grouse",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "partridge",
      term: "partridge",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "ibis",
      term: "ibis",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "spoonbill",
      term: "spoonbill",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "egret",
      term: "egret",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "stork",
      term: "stork",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "calf",
      term: "calf",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "kid",
      term: "kid",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "piglet",
      term: "piglet",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "fawn",
      term: "fawn",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "pig",
      term: "pig",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "swine",
      term: "swine",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "donkey",
      term: "donkey",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "mule",
      term: "mule",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "british shorthair",
      term: "British Shorthair",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "scottish fold",
      term: "Scottish Fold",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "norwegian forest cat",
      term: "Norwegian Forest Cat",
      categories: [
        "animals"
      ],
      aliases: [
        "\u632A\u5A01\u68EE\u6797\u732B"
      ],
      related: []
    },
    {
      id: "turkish angora",
      term: "Turkish Angora",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "birman",
      term: "Birman",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "russian blue",
      term: "Russian Blue",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "french bulldog",
      term: "French bulldog",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "dachshund",
      term: "Dachshund",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "beagle",
      term: "Beagle",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "poodle",
      term: "Poodle",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "holland lop",
      term: "Holland lop",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "netherland dwarf",
      term: "Netherland dwarf",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "lionhead rabbit",
      term: "Lionhead rabbit",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "chinchilla",
      term: "chinchilla",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "saiga",
      term: "saiga",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "maned wolf",
      term: "maned wolf",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "baboon",
      term: "baboon",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "mandrill",
      term: "mandrill",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "macaque",
      term: "macaque",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "howler monkey",
      term: "howler monkey",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "hare",
      term: "hare",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "sea lion",
      term: "sea lion",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "bee-eater",
      term: "bee-eater",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "hornbill",
      term: "hornbill",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "foal",
      term: "foal",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "draft horse",
      term: "draft horse",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "persian",
      term: "Persian",
      categories: [
        "animals"
      ],
      aliases: [
        "\u6CE2\u65AF\u732B"
      ],
      related: []
    },
    {
      id: "siamese",
      term: "Siamese",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "bengal",
      term: "Bengal",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "labrador",
      term: "Labrador",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "border collie",
      term: "border collie",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "corgi",
      term: "corgi",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "husky",
      term: "husky",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "samoyed",
      term: "Samoyed",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "dalmatian",
      term: "Dalmatian",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "spaniel",
      term: "spaniel",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "terrier",
      term: "terrier",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "lop rabbit",
      term: "lop rabbit",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "angora rabbit",
      term: "Angora rabbit",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "dutch rabbit",
      term: "Dutch rabbit",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "arabian horse",
      term: "Arabian horse",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "icelandic horse",
      term: "Icelandic horse",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "shetland pony",
      term: "Shetland pony",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "thoroughbred",
      term: "thoroughbred",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "snow leopard",
      term: "snow leopard",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "arctic fox",
      term: "arctic fox",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "wolf",
      term: "wolf",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "coyote",
      term: "coyote",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "jackal",
      term: "jackal",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "sea otter",
      term: "sea otter",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "antelope",
      term: "antelope",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "cockatoo",
      term: "cockatoo",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "cockatiel",
      term: "cockatiel",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "sunrise",
      term: "sunrise",
      categories: [
        "animals",
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "sunset",
      term: "sunset",
      categories: [
        "animals",
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "golden hour",
      term: "golden hour",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "soft light",
      term: "soft light",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "morning light",
      term: "morning light",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "meadow",
      term: "meadow",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "pasture",
      term: "pasture",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "grassland",
      term: "grassland",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "field",
      term: "field",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "forest",
      term: "forest",
      categories: [
        "animals",
        "landscape"
      ],
      aliases: [
        "\u68EE\u6797"
      ],
      related: []
    },
    {
      id: "woodland",
      term: "woodland",
      categories: [
        "animals",
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "autumn",
      term: "autumn",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "snow",
      term: "snow",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "wetland",
      term: "wetland",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "rainforest",
      term: "rainforest",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "jungle",
      term: "jungle",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "canopy",
      term: "canopy",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "countryside",
      term: "countryside",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "full body",
      term: "full body",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "whole body",
      term: "whole body",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "side view",
      term: "side view",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "profile view",
      term: "profile view",
      categories: [
        "animals"
      ],
      aliases: [],
      related: []
    },
    {
      id: "dish",
      term: "dish",
      categories: [
        "food"
      ],
      aliases: [
        "\u83DC\u80B4"
      ],
      related: []
    },
    {
      id: "cuisine",
      term: "cuisine",
      categories: [
        "food"
      ],
      aliases: [
        "\u7F8E\u98DF"
      ],
      related: []
    },
    {
      id: "dessert",
      term: "dessert",
      categories: [
        "food"
      ],
      aliases: [
        "\u751C\u70B9"
      ],
      related: []
    },
    {
      id: "pastry",
      term: "pastry",
      categories: [
        "food"
      ],
      aliases: [
        "\u7CD5\u70B9"
      ],
      related: []
    },
    {
      id: "bakery",
      term: "bakery",
      categories: [
        "food"
      ],
      aliases: [
        "\u70D8\u7119"
      ],
      related: []
    },
    {
      id: "barbecue",
      term: "barbecue",
      categories: [
        "food"
      ],
      aliases: [
        "\u70E7\u70E4"
      ],
      related: []
    },
    {
      id: "seafood",
      term: "seafood",
      categories: [
        "food"
      ],
      aliases: [
        "\u6D77\u9C9C"
      ],
      related: []
    },
    {
      id: "food",
      term: "food",
      categories: [
        "food"
      ],
      aliases: [
        "\u98DF\u7269"
      ],
      related: []
    },
    {
      id: "plate",
      term: "plate",
      categories: [
        "food"
      ],
      aliases: [],
      related: []
    },
    {
      id: "meal",
      term: "meal",
      categories: [
        "food"
      ],
      aliases: [
        "\u9910\u98DF"
      ],
      related: []
    },
    {
      id: "bread",
      term: "bread",
      categories: [
        "food"
      ],
      aliases: [
        "\u9762\u5305"
      ],
      related: []
    },
    {
      id: "fish",
      term: "fish",
      categories: [
        "food"
      ],
      aliases: [],
      related: []
    },
    {
      id: "fruit",
      term: "fruit",
      categories: [
        "food"
      ],
      aliases: [
        "\u6C34\u679C"
      ],
      related: []
    },
    {
      id: "vegetable",
      term: "vegetable",
      categories: [
        "food"
      ],
      aliases: [
        "\u852C\u83DC"
      ],
      related: []
    },
    {
      id: "rice",
      term: "rice",
      categories: [
        "food"
      ],
      aliases: [
        "\u7C73\u996D"
      ],
      related: []
    },
    {
      id: "noodle",
      term: "noodle",
      categories: [
        "food"
      ],
      aliases: [
        "\u9762\u6761"
      ],
      related: []
    },
    {
      id: "served",
      term: "served",
      categories: [
        "food"
      ],
      aliases: [],
      related: []
    },
    {
      id: "loaf",
      term: "loaf",
      categories: [
        "food"
      ],
      aliases: [],
      related: []
    },
    {
      id: "landscape",
      term: "landscape",
      categories: [
        "landscape"
      ],
      aliases: [
        "\u98CE\u666F"
      ],
      related: [
        "mountain",
        "lake",
        "waterfall",
        "forest"
      ]
    },
    {
      id: "scenery",
      term: "scenery",
      categories: [
        "landscape"
      ],
      aliases: [
        "\u666F\u8272"
      ],
      related: []
    },
    {
      id: "scenic",
      term: "scenic",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "seascape",
      term: "seascape",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "coastal landscape",
      term: "coastal landscape",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "panorama",
      term: "panorama",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "mountain",
      term: "mountain",
      categories: [
        "landscape"
      ],
      aliases: [
        "\u5C71\u8109"
      ],
      related: []
    },
    {
      id: "mountain range",
      term: "mountain range",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "glacier",
      term: "glacier",
      categories: [
        "landscape"
      ],
      aliases: [
        "\u51B0\u5DDD"
      ],
      related: []
    },
    {
      id: "fjord",
      term: "fjord",
      categories: [
        "landscape"
      ],
      aliases: [
        "\u5CE1\u6E7E"
      ],
      related: []
    },
    {
      id: "canyon",
      term: "canyon",
      categories: [
        "landscape"
      ],
      aliases: [
        "\u5CE1\u8C37"
      ],
      related: []
    },
    {
      id: "valley",
      term: "valley",
      categories: [
        "landscape"
      ],
      aliases: [
        "\u5C71\u8C37"
      ],
      related: []
    },
    {
      id: "river valley",
      term: "river valley",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "volcano",
      term: "volcano",
      categories: [
        "landscape"
      ],
      aliases: [
        "\u706B\u5C71"
      ],
      related: []
    },
    {
      id: "desert",
      term: "desert",
      categories: [
        "landscape"
      ],
      aliases: [
        "\u6C99\u6F20"
      ],
      related: []
    },
    {
      id: "dune",
      term: "dune",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "beach",
      term: "beach",
      categories: [
        "landscape"
      ],
      aliases: [
        "\u6D77\u6EE9"
      ],
      related: []
    },
    {
      id: "coastline",
      term: "coastline",
      categories: [
        "landscape"
      ],
      aliases: [
        "\u6D77\u5CB8\u7EBF"
      ],
      related: []
    },
    {
      id: "waterfall",
      term: "waterfall",
      categories: [
        "landscape"
      ],
      aliases: [
        "\u7011\u5E03"
      ],
      related: []
    },
    {
      id: "lake",
      term: "lake",
      categories: [
        "landscape"
      ],
      aliases: [
        "\u6E56\u6CCA"
      ],
      related: []
    },
    {
      id: "river",
      term: "river",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "iceberg",
      term: "iceberg",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "ice field",
      term: "ice field",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "polar landscape",
      term: "polar landscape",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "national park",
      term: "national park",
      categories: [
        "landscape"
      ],
      aliases: [
        "\u56FD\u5BB6\u516C\u56ED"
      ],
      related: []
    },
    {
      id: "city skyline",
      term: "city skyline",
      categories: [
        "landscape"
      ],
      aliases: [
        "\u57CE\u5E02\u5929\u9645\u7EBF"
      ],
      related: []
    },
    {
      id: "city panorama",
      term: "city panorama",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "urban skyline",
      term: "urban skyline",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "patagonia",
      term: "Patagonia",
      categories: [
        "landscape"
      ],
      aliases: [
        "\u5DF4\u5854\u54E5\u5C3C\u4E9A"
      ],
      related: []
    },
    {
      id: "yosemite",
      term: "Yosemite",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "yellowstone",
      term: "Yellowstone",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "banff",
      term: "Banff",
      categories: [
        "landscape"
      ],
      aliases: [
        "\u73ED\u592B"
      ],
      related: []
    },
    {
      id: "torres del paine",
      term: "Torres del Paine",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "milford sound",
      term: "Milford Sound",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "matterhorn",
      term: "Matterhorn",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "swiss alps",
      term: "Swiss Alps",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "grand canyon",
      term: "Grand Canyon",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "iceland",
      term: "Iceland",
      categories: [
        "landscape"
      ],
      aliases: [
        "\u51B0\u5C9B"
      ],
      related: []
    },
    {
      id: "lofoten islands",
      term: "Lofoten Islands",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "faroe islands",
      term: "Faroe Islands",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "serengeti",
      term: "Serengeti",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "sahara",
      term: "Sahara",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "great barrier reef",
      term: "Great Barrier Reef",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "lake baikal",
      term: "Lake Baikal",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "dolomites",
      term: "Dolomites",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "lake bled",
      term: "Lake Bled",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "plitvice lakes",
      term: "Plitvice Lakes",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "mount roraima",
      term: "Mount Roraima",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "aoraki",
      term: "Aoraki",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "mount cook",
      term: "Mount Cook",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "fiordland",
      term: "Fiordland",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "kilimanjaro",
      term: "Kilimanjaro",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "table mountain",
      term: "Table Mountain",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "zion",
      term: "Zion",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "bryce canyon",
      term: "Bryce Canyon",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "arches",
      term: "Arches",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "glacier national park",
      term: "Glacier National Park",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "olympic national park",
      term: "Olympic National Park",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "acadia",
      term: "Acadia",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "denali national park",
      term: "Denali National Park",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "rocky mountain national park",
      term: "Rocky Mountain National Park",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "great smoky mountains",
      term: "Great Smoky Mountains",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "scottish highlands",
      term: "Scottish Highlands",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "lake district",
      term: "Lake District",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "french alps",
      term: "French Alps",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "pyrenees",
      term: "Pyrenees",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "black forest",
      term: "Black Forest",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "saxon switzerland",
      term: "Saxon Switzerland",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "lauterbrunnen",
      term: "Lauterbrunnen",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "lake como",
      term: "Lake Como",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "amalfi coast",
      term: "Amalfi Coast",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "salar de uyuni",
      term: "Salar de Uyuni",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "atacama",
      term: "Atacama",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "iguazu falls",
      term: "Iguazu Falls",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "len\xE7\xF3is maranhenses",
      term: "Len\xE7\xF3is Maranhenses",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "galapagos",
      term: "Galapagos",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "blyde river canyon",
      term: "Blyde River Canyon",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "drakensberg",
      term: "Drakensberg",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "fish river canyon",
      term: "Fish River Canyon",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "okavango",
      term: "Okavango",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "hokkaido",
      term: "Hokkaido",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "mount fuji",
      term: "Mount Fuji",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "jeju",
      term: "Jeju",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "himalaya",
      term: "Himalaya",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "nepal",
      term: "Nepal",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "bhutan",
      term: "Bhutan",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "ladakh",
      term: "Ladakh",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "lake tekapo",
      term: "Lake Tekapo",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "milford track",
      term: "Milford Track",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "joshua tree",
      term: "Joshua Tree",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "death valley",
      term: "Death Valley",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "capitol reef",
      term: "Capitol Reef",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "canyonlands",
      term: "Canyonlands",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "sequoia national park",
      term: "Sequoia National Park",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "kings canyon",
      term: "Kings Canyon",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "badlands national park",
      term: "Badlands National Park",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "mount rainier",
      term: "Mount Rainier",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "isle of skye",
      term: "Isle of Skye",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "glencoe",
      term: "Glencoe",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "snowdonia",
      term: "Snowdonia",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "connemara",
      term: "Connemara",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "cliffs of moher",
      term: "Cliffs of Moher",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "provence",
      term: "Provence",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "tuscany",
      term: "Tuscany",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "picos de europa",
      term: "Picos de Europa",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "madeira",
      term: "Madeira",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "paine massif",
      term: "Paine Massif",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "fitz roy",
      term: "Fitz Roy",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "perito moreno",
      term: "Perito Moreno",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "chapada diamantina",
      term: "Chapada Diamantina",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "pantanal",
      term: "Pantanal",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "victoria falls",
      term: "Victoria Falls",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "simien mountains",
      term: "Simien Mountains",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "ngorongoro",
      term: "Ngorongoro",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "kerala backwaters",
      term: "Kerala backwaters",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "ha long bay",
      term: "Ha Long Bay",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "komodo",
      term: "Komodo",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "bromo",
      term: "Bromo",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "rinjani",
      term: "Rinjani",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "khao sok",
      term: "Khao Sok",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "karakoram",
      term: "Karakoram",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "pamir",
      term: "Pamir",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "tien shan",
      term: "Tien Shan",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "skeleton coast",
      term: "Skeleton Coast",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "wadi rum",
      term: "Wadi Rum",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "socotra",
      term: "Socotra",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "danakil",
      term: "Danakil",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "dallol",
      term: "Dallol",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "rwenzori mountains",
      term: "Rwenzori Mountains",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "mount kenya",
      term: "Mount Kenya",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "atlas mountains",
      term: "Atlas Mountains",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "geirangerfjord",
      term: "Geirangerfjord",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "trolltunga",
      term: "Trolltunga",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "jotunheimen",
      term: "Jotunheimen",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "vatnajokull",
      term: "Vatnajokull",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "landmannalaugar",
      term: "Landmannalaugar",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "lake louise",
      term: "Lake Louise",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "moraine lake",
      term: "Moraine Lake",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "jasper",
      term: "Jasper",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "grand teton",
      term: "Grand Teton",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "white sands",
      term: "White Sands",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "monument valley",
      term: "Monument Valley",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "antelope canyon",
      term: "Antelope Canyon",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "crater lake",
      term: "Crater Lake",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "big sur",
      term: "Big Sur",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "redwood national park",
      term: "Redwood National Park",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "everglades national park",
      term: "Everglades National Park",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "lake powell",
      term: "Lake Powell",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "azores",
      term: "Azores",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "tenerife",
      term: "Tenerife",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "teide",
      term: "Teide",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "canary islands",
      term: "Canary Islands",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "caucasus",
      term: "Caucasus",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "kazbegi",
      term: "Kazbegi",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "svaneti",
      term: "Svaneti",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "annapurna",
      term: "Annapurna",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "langtang",
      term: "Langtang",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "hunza",
      term: "Hunza",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "uluru",
      term: "Uluru",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "kakadu",
      term: "Kakadu",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "blue mountains",
      term: "Blue Mountains",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "great ocean road",
      term: "Great Ocean Road",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "tasmania",
      term: "Tasmania",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "cradle mountain",
      term: "Cradle Mountain",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "tongariro",
      term: "Tongariro",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "abel tasman",
      term: "Abel Tasman",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "doubtful sound",
      term: "Doubtful Sound",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "shiretoko",
      term: "Shiretoko",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "yakushima",
      term: "Yakushima",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "kamikochi",
      term: "Kamikochi",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "aso kuju",
      term: "Aso Kuju",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "kerinci seblat",
      term: "Kerinci Seblat",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "raja ampat",
      term: "Raja Ampat",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "palawan",
      term: "Palawan",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "batanes",
      term: "Batanes",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "phong nha",
      term: "Phong Nha",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "ansel adams",
      term: "Ansel Adams",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "galen rowell",
      term: "Galen Rowell",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "michael kenna",
      term: "Michael Kenna",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "david muench",
      term: "David Muench",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "art wolfe",
      term: "Art Wolfe",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "frans lanting",
      term: "Frans Lanting",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "sebastiao salgado",
      term: "Sebastiao Salgado",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "sebasti\xE3o salgado",
      term: "Sebasti\xE3o Salgado",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "peter lik",
      term: "Peter Lik",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "marc adamus",
      term: "Marc Adamus",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "max rive",
      term: "Max Rive",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "chris burkard",
      term: "Chris Burkard",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "thomas heaton",
      term: "Thomas Heaton",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "lofoten",
      term: "Lofoten",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "rockies",
      term: "Rockies",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "new york",
      term: "New York",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "skyline",
      term: "skyline",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "paris",
      term: "Paris",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "london",
      term: "London",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "rio de janeiro",
      term: "Rio de Janeiro",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "cape town",
      term: "Cape Town",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "sydney",
      term: "Sydney",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "vancouver",
      term: "Vancouver",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "reykjavik",
      term: "Reykjavik",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "coastal",
      term: "coastal",
      categories: [
        "landscape"
      ],
      aliases: [],
      related: []
    },
    {
      id: "movie poster",
      term: "movie poster",
      categories: [
        "movie-poster"
      ],
      aliases: [
        "\u7535\u5F71\u6D77\u62A5"
      ],
      related: []
    },
    {
      id: "film poster",
      term: "film poster",
      categories: [
        "movie-poster"
      ],
      aliases: [
        "\u5F71\u7247\u6D77\u62A5"
      ],
      related: []
    },
    {
      id: "poster",
      term: "poster",
      categories: [
        "movie-poster"
      ],
      aliases: [
        "\u6D77\u62A5"
      ],
      related: []
    },
    {
      id: "promotional poster",
      term: "promotional poster",
      categories: [
        "movie-poster"
      ],
      aliases: [],
      related: []
    },
    {
      id: "theatrical poster",
      term: "theatrical poster",
      categories: [
        "movie-poster"
      ],
      aliases: [],
      related: []
    },
    {
      id: "planet",
      term: "planet",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [
        "\u884C\u661F"
      ],
      related: []
    },
    {
      id: "earth",
      term: "earth",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [
        "\u5730\u7403"
      ],
      related: []
    },
    {
      id: "moon",
      term: "moon",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [
        "\u6708\u7403"
      ],
      related: []
    },
    {
      id: "lunar",
      term: "lunar",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "solar flare",
      term: "solar flare",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [
        "\u592A\u9633\u8000\u6591"
      ],
      related: []
    },
    {
      id: "solar corona",
      term: "solar corona",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "solar prominence",
      term: "solar prominence",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "solar system",
      term: "solar system",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [
        "\u592A\u9633\u7CFB"
      ],
      related: []
    },
    {
      id: "galaxy",
      term: "galaxy",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [
        "\u661F\u7CFB"
      ],
      related: []
    },
    {
      id: "nebula",
      term: "nebula",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [
        "\u661F\u4E91"
      ],
      related: [
        "orion nebula",
        "carina nebula",
        "crab nebula",
        "horsehead nebula"
      ]
    },
    {
      id: "comet",
      term: "comet",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [
        "\u5F57\u661F"
      ],
      related: []
    },
    {
      id: "asteroid",
      term: "asteroid",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [
        "\u5C0F\u884C\u661F"
      ],
      related: []
    },
    {
      id: "meteorite",
      term: "meteorite",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "black hole",
      term: "black hole",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [
        "\u9ED1\u6D1E"
      ],
      related: []
    },
    {
      id: "event horizon",
      term: "event horizon",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "accretion disk",
      term: "accretion disk",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "supernova",
      term: "supernova",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [
        "\u8D85\u65B0\u661F"
      ],
      related: []
    },
    {
      id: "quasar",
      term: "quasar",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "spiral galaxy",
      term: "spiral galaxy",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "star forming region",
      term: "star forming region",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "orion nebula",
      term: "orion nebula",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [
        "\u730E\u6237\u5EA7\u661F\u4E91"
      ],
      related: []
    },
    {
      id: "carina nebula",
      term: "carina nebula",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "crab nebula",
      term: "crab nebula",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "tarantula nebula",
      term: "tarantula nebula",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "vela supernova remnant",
      term: "vela supernova remnant",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "cygnus loop",
      term: "cygnus loop",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "magellanic cloud",
      term: "magellanic cloud",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "horsehead nebula",
      term: "horsehead nebula",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "flame nebula",
      term: "flame nebula",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "pillars of creation",
      term: "pillars of creation",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "eagle nebula",
      term: "eagle nebula",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "helix nebula",
      term: "helix nebula",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "ring nebula",
      term: "ring nebula",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "rosette nebula",
      term: "rosette nebula",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "lagoon nebula",
      term: "lagoon nebula",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "eta carinae",
      term: "eta carinae",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "centaurus a",
      term: "centaurus a",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "james webb",
      term: "james webb",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [
        "\u97E6\u5E03\u671B\u8FDC\u955C"
      ],
      related: []
    },
    {
      id: "hubble",
      term: "hubble",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [
        "\u54C8\u52C3"
      ],
      related: []
    },
    {
      id: "star field",
      term: "star field",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "star cluster",
      term: "star cluster",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "starry sky",
      term: "starry sky",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "star trails",
      term: "star trails",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "milky way",
      term: "milky way",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [
        "\u94F6\u6CB3"
      ],
      related: []
    },
    {
      id: "exoplanet",
      term: "exoplanet",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "artist impression",
      term: "artist impression",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "artist's impression",
      term: "artist's impression",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    },
    {
      id: "digital illustration",
      term: "digital illustration",
      categories: [
        "celestial-body-wallpaper"
      ],
      aliases: [],
      related: []
    }
  ];

  // src/client/afp-search-suggestions.js
  var normalized = (value) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();
  function suggestKeywords(catalog, query, category = "") {
    const needle = normalized(query), rows = catalog.filter((row) => !category || row.categories.includes(category));
    if (!needle) {
      if (category) return rows.slice(0, 10);
      const chosen = /* @__PURE__ */ new Map();
      for (const key of ["animals", "food", "landscape", "movie-poster", "celestial-body-wallpaper"]) {
        for (const row of rows.filter((item) => item.categories.includes(key)).slice(0, 2)) chosen.set(row.id, row);
      }
      return [...chosen.values()];
    }
    const exact = catalog.find((row) => [row.term, ...row.aliases].some((value) => normalized(value) === needle));
    return rows.map((row, index) => {
      const values = [row.term, ...row.aliases].map(normalized);
      const rank2 = values.includes(needle) ? 0 : exact?.related.includes(row.id) ? 1 : values.some((value) => value.startsWith(needle)) ? 2 : values.some((value) => value.split(/\s+/).some((word) => word.startsWith(needle))) ? 3 : values.some((value) => value.includes(needle)) ? 4 : Infinity;
      return { row, rank: rank2, index };
    }).filter((item) => Number.isFinite(item.rank)).sort((a, b) => a.rank - b.rank || a.index - b.index).slice(0, 10).map((item) => item.row);
  }
  function suggestionKey(event, index, count, open) {
    if (event.isComposing || event.keyCode === 229) return { action: "none", index };
    if (event.key === "Escape" && open) return { action: "close", index: -1 };
    if (count && event.key === "ArrowDown") return { action: "navigate", index: open ? (index + 1) % count : 0 };
    if (count && event.key === "ArrowUp") return { action: "navigate", index: open && index >= 0 ? (index - 1 + count) % count : count - 1 };
    if (event.key === "Enter") return { action: open && index >= 0 && index < count ? "pick" : "submit", index };
    return { action: "none", index };
  }
  function placeSuggestions(rect, width, height, topMargin = 8, contentHeight = 380) {
    const menuWidth = Math.min(rect.width, Math.max(0, width - 16)), below = Math.max(0, height - rect.bottom - 12);
    const above = Math.max(0, rect.top - topMargin - 4), wanted = Math.min(380, contentHeight);
    const down = below >= wanted || below >= above;
    return {
      position: "fixed",
      left: Math.max(8, Math.min(rect.left, width - menuWidth - 8)),
      width: menuWidth,
      top: down ? rect.bottom + 4 : Math.max(topMargin, rect.top - Math.min(wanted, above) - 4),
      maxHeight: down ? Math.min(380, below) : Math.min(380, above)
    };
  }

  // src/client/afp-search-input.js
  function createAfpSearchInput(React, UI, icons, t) {
    const h = React.createElement, { Input, Button, Tag, MenuSurface, createPortal, useDismissOnOutsidePointer } = UI;
    return function AfpSearchInput({ value, onChange, enabled = true }) {
      const [open, setOpen] = React.useState(false), [category, setCategory] = React.useState(""), [active2, setActive] = React.useState(-1);
      const [position, setPosition] = React.useState(null);
      const root = React.useRef(null), surface = React.useRef(null), composing = React.useRef(false);
      const restoringFocus = React.useRef(false);
      const id = React.useId(), rows = suggestKeywords(afp_search_catalog_default, value, category);
      const visible = enabled && open && Boolean(MenuSurface && createPortal);
      React.useEffect(() => {
        if (!enabled) {
          setOpen(false);
          setActive(-1);
        }
      }, [enabled]);
      useDismissOnOutsidePointer?.(root, visible, setOpen, surface);
      React.useLayoutEffect(() => {
        if (!visible) return;
        const update = () => {
          if (!root.current) return;
          const clearance = Number.parseFloat(getComputedStyle(root.current).getPropertyValue("--dsh-frame-top-clearance")) || 0;
          const next = placeSuggestions(root.current.getBoundingClientRect(), window.innerWidth, window.innerHeight, clearance + 8, surface.current?.scrollHeight || 380);
          setPosition(next);
        };
        update();
        window.addEventListener("resize", update);
        document.addEventListener("scroll", update, true);
        const resize = new ResizeObserver(update);
        resize.observe(root.current);
        return () => {
          resize.disconnect();
          window.removeEventListener("resize", update);
          document.removeEventListener("scroll", update, true);
        };
      }, [visible, value, category]);
      React.useEffect(() => {
        setActive(-1);
      }, [value, category]);
      React.useEffect(() => {
        if (visible && active2 >= 0) surface.current?.querySelector(`#${CSS.escape(`${id}-option-${active2}`)}`)?.scrollIntoView({ block: "nearest" });
      }, [active2, visible, id]);
      const focusInput = () => {
        restoringFocus.current = true;
        root.current?.querySelector("input")?.focus();
        restoringFocus.current = false;
      };
      const pick = (row) => {
        onChange(row.term);
        setActive(-1);
        setOpen(false);
        focusInput();
      };
      const keydown = (event) => {
        const result = suggestionKey({ key: event.key, keyCode: event.keyCode, isComposing: composing.current || event.nativeEvent?.isComposing }, active2, rows.length, visible);
        if (result.action === "none") {
          if (event.key === "Enter" && (composing.current || event.nativeEvent?.isComposing || event.keyCode === 229)) event.preventDefault();
          return;
        }
        if (result.action === "submit") {
          setOpen(false);
          return;
        }
        event.preventDefault();
        if (result.action === "navigate") {
          setOpen(true);
          setActive(result.index);
        }
        if (result.action === "close") {
          event.stopPropagation();
          setOpen(false);
          setActive(-1);
        }
        if (result.action === "pick") pick(rows[result.index]);
      };
      const popup = visible ? h(
        MenuSurface,
        {
          ref: surface,
          compact: true,
          className: "afp-wb-search-suggestions",
          style: position ?? { visibility: "hidden", position: "fixed", top: 0, left: 0 },
          onKeyDown: (event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              focusInput();
            }
          }
        },
        h("div", { className: "afp-wb-suggestion-heading" }, h("span", null, t("keywordSuggestions")), h(Tag, { tone: "quiet" }, t("skillKeywords"))),
        h(
          "div",
          { className: "afp-wb-suggestion-categories", "aria-label": t("suggestionCategories") },
          ...["", "animals", "food", "landscape", "movie-poster", "celestial-body-wallpaper"].map((key) => h(Button, {
            key,
            type: "button",
            size: "sm",
            variant: category === key ? "outline" : "ghost",
            "aria-pressed": category === key,
            onMouseDown: (event) => event.preventDefault(),
            onClick: () => {
              setCategory(key);
              setActive(-1);
            }
          }, t(key || "allCategories")))
        ),
        h(
          "div",
          { id: `${id}-list`, role: "listbox", "aria-label": t("keywordSuggestions"), className: "afp-wb-suggestion-list" },
          ...rows.map((row, index) => h(
            "div",
            {
              id: `${id}-option-${index}`,
              key: row.id,
              role: "option",
              "aria-selected": active2 === index,
              className: `afp-wb-suggestion-row${active2 === index ? " is-active" : ""}`,
              onMouseEnter: () => setActive(index),
              onMouseDown: (event) => event.preventDefault(),
              onClick: () => pick(row)
            },
            h(
              "div",
              null,
              h("span", { className: "afp-wb-suggestion-term" }, row.term),
              row.aliases.length ? h("span", { className: "afp-wb-suggestion-aliases" }, row.aliases.join(" \xB7 ")) : null
            ),
            h(Tag, { tone: "quiet" }, row.categories.map(t).join(" \xB7 "))
          ))
        ),
        !rows.length ? h("p", { className: "afp-wb-suggestion-empty", role: "status" }, t("noKeywordSuggestions")) : null,
        h("p", { className: "afp-wb-suggestion-hint" }, t("keywordSuggestionHint"))
      ) : null;
      return h(
        "div",
        {
          className: "afp-wb-search-input-slot",
          ref: root,
          onBlur: (event) => {
            if (!root.current?.contains(event.relatedTarget) && !surface.current?.contains(event.relatedTarget)) setOpen(false);
          }
        },
        h(Input, {
          className: "afp-wb-input afp-wb-search-input",
          value,
          placeholder: t("query"),
          "aria-label": t("query"),
          role: "combobox",
          "aria-autocomplete": "list",
          "aria-expanded": visible,
          "aria-controls": visible ? `${id}-list` : void 0,
          "aria-activedescendant": visible && active2 >= 0 && active2 < rows.length ? `${id}-option-${active2}` : void 0,
          autoComplete: "off",
          icon: icons.IconSearchOutlineRegular ? h(icons.IconSearchOutlineRegular, { size: 16 }) : null,
          onFocus: () => {
            if (!restoringFocus.current) setOpen(true);
          },
          onChange: (event) => {
            onChange(event.target.value);
            setActive(-1);
            setOpen(true);
          },
          onKeyDown: keydown,
          onCompositionStart: () => {
            composing.current = true;
          },
          onCompositionEnd: () => {
            composing.current = false;
          }
        }),
        popup ? createPortal(popup, document.body) : null
      );
    };
  }

  // src/client/afp-add-favorites-dialog.js
  function createAfpAddFavoritesDialog(React, UI, icons, t, store, ImagePreview) {
    const h = React.createElement, { Modal, Input, Button, Tag, StateDot } = UI;
    return function AfpAddFavoritesDialog({ state }) {
      const [query, setQuery] = React.useState(""), [targetId, setTargetId] = React.useState("");
      const request = state.favoritesRequest, region = state.regions.collections, result = state.favoritesResult;
      React.useEffect(() => {
        setQuery("");
        setTargetId("");
      }, [request]);
      if (!request || !Modal) return null;
      const collections = (region.data?.items ?? []).filter((item) => item.name?.trim() && !item.readOnly);
      const filtered = collections.filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase()));
      const target = collections.find((item) => item.id === targetId);
      const allowed = state.status?.features?.includes("write") && state.status?.features?.includes("read");
      const disabled = !target || !allowed || state.busy || state.favoritesBusy || region.loading || Boolean(region.error);
      const text = (key, count) => t(key).replace("{count}", String(count));
      const close = () => store.closeAddFavorites();
      const completed = (result?.items ?? []).filter((row) => row.status === "completed");
      const detailed = completed.every((row) => ["added", "already-present"].includes(row.membershipChange));
      return h(
        Modal,
        {
          open: true,
          title: t("addFavorites"),
          closeLabel: t("close"),
          onClose: close,
          className: "afp-wb-action-modal afp-wb-add-favorites-modal",
          contentClassName: "afp-wb-action-modal-content",
          footer: h(
            "div",
            { className: "afp-wb-dialog-footer" },
            h(Button, { variant: "ghost", disabled: state.favoritesBusy, onClick: close }, t(result ? "close" : "cancel")),
            !result ? h(Button, {
              variant: "primary",
              disabled,
              "aria-busy": state.favoritesBusy,
              icon: state.favoritesBusy ? h(StateDot, { state: "ongoing", size: 14 }) : icons.IconFolderOpenOutlineRegular ? h(icons.IconFolderOpenOutlineRegular, { size: 16 }) : null,
              onClick: () => {
                void store.addFavorites(targetId);
              }
            }, t(state.favoritesBusy ? "addingFavorites" : "confirmAddFavorites")) : null
          )
        },
        h(
          "div",
          { className: "afp-wb-add-selection-summary" },
          h("div", { className: "afp-wb-add-thumbnails", "aria-hidden": true }, ...request.photos.slice(0, 4).map((photo) => h(ImagePreview, { key: photo.id, photo }))),
          h("div", null, h("strong", null, text("selectedPhotoCount", request.photos.length)), h("p", null, t("addFavoritesHelp")))
        ),
        !result ? h(
          "div",
          { className: "afp-wb-add-targets" },
          h(Input, {
            className: "afp-wb-input",
            value: query,
            placeholder: t("filterCollections"),
            "aria-label": t("filterCollections"),
            disabled: state.favoritesBusy,
            onChange: (event) => setQuery(event.target.value),
            icon: icons.IconSearchOutlineRegular ? h(icons.IconSearchOutlineRegular, { size: 16 }) : null
          }),
          region.loading ? h(
            "div",
            { className: "afp-wb-add-skeleton", role: "status", "aria-label": t("loading") },
            ...Array.from({ length: 3 }, (_, index) => h("span", { key: index, className: "afp-skeleton" }))
          ) : null,
          region.error ? h(
            "div",
            { className: "afp-wb-error-row", role: "alert" },
            t("regionReadFailed"),
            h(Button, { variant: "ghost", disabled: region.loading || state.favoritesBusy, onClick: () => {
              void store.loadCollections();
            } }, t("retry"))
          ) : null,
          h("div", { className: "afp-wb-add-target-list", role: "group", "aria-label": t("targetCollection") }, ...filtered.map((item) => h(
            Button,
            {
              key: item.id,
              variant: "ghost",
              className: `afp-wb-add-target${targetId === item.id ? " is-selected" : ""}`,
              disabled: state.favoritesBusy || region.loading,
              "aria-pressed": targetId === item.id,
              onClick: () => setTargetId(item.id)
            },
            icons.IconFolderOpenOutlineRegular ? h(icons.IconFolderOpenOutlineRegular, { size: 18 }) : null,
            h("span", { className: "afp-wb-add-target-name" }, item.name),
            h(Tag, { tone: "info" }, t("private")),
            h(Tag, { tone: "quiet" }, item.count == null ? "\u2014" : String(item.count))
          ))),
          !region.loading && !region.error && !filtered.length ? h("p", { className: "afp-wb-subtle" }, t(collections.length ? "noMatchingCollections" : "noWritableCollections")) : null,
          target ? h("p", { className: "afp-wb-subtle" }, `${t("targetCollection")}: ${target.name}`) : null,
          !allowed ? h("p", { className: "afp-wb-error-row", role: "alert" }, t("favoritesPermissionsRequired")) : null
        ) : null,
        state.favoritesError ? h("p", { className: "afp-wb-error-row", role: "alert" }, t("favoritesWriteUncertain")) : null,
        result ? h(
          "div",
          { className: "afp-wb-add-result", role: "status" },
          h(
            "div",
            { className: "afp-wb-add-result-tags" },
            detailed ? h(
              React.Fragment,
              null,
              h(Tag, { tone: "success" }, text("favoritesAdded", completed.filter((row) => row.membershipChange === "added").length)),
              h(Tag, { tone: "quiet" }, text("favoritesExisting", completed.filter((row) => row.membershipChange === "already-present").length))
            ) : h(Tag, { tone: "success" }, text("favoritesCompleted", result.completed)),
            h(Tag, { tone: result.failed ? "warning" : "quiet" }, text("favoritesFailed", result.failed ?? 0)),
            h(Tag, { tone: result.pending ? "warning" : "quiet" }, text("favoritesPending", result.pending ?? 0))
          ),
          (result.items ?? []).some((row) => row.status !== "completed") ? h("p", null, t("favoritesPartialHelp")) : null,
          ...(result.items ?? []).filter((row) => row.status !== "completed").map((row) => h(
            "div",
            { key: row.photoId, className: "afp-wb-add-result-row" },
            h("span", null, row.title || request.photos.find((photo) => photo.id === row.photoId)?.title || row.photoId),
            h(Tag, { tone: "warning" }, t(row.status === "pending" ? "favoritesPendingLabel" : "failed"))
          ))
        ) : null
      );
    };
  }

  // src/client/afp-workbench.js
  var tabs = ["search", "collections", "tasks", "changes", "account"];
  function createWorkbench(React, UI, ctx, t, store, ConfigurationForm, icons = {}) {
    const h = React.createElement;
    const { Button, Input, Switch, Tag, Toast, StateDot, SegmentedControl, Tooltip, Modal, Checkbox, GlideHighlight } = UI;
    const Selector = createAfpSelector(React, UI, icons.IconChevronDownOutlineRegular);
    const Gallery = createAfpGallery(React, UI, icons, t, store);
    const DownloadDialog = createAfpDownloadDialog(React, UI, icons, t, store, Gallery.ImagePreview);
    const SearchInput = createAfpSearchInput(React, UI, icons, t);
    const AddFavoritesDialog = createAfpAddFavoritesDialog(React, UI, icons, t, store, Gallery.ImagePreview);
    const TaskPanels = createAfpTaskPanels(React, UI, t, store, Gallery, Selector, icons);
    function handleTab(tab) {
      store.selectTab(tab);
      const state = store.getSnapshot();
      if (tab === "collections" && !state.regions.collections.data && !state.regions.collections.loading) {
        void store.loadCollections().then(() => {
          const latest = store.getSnapshot(), first = latest.regions.collections.data?.items?.find((item) => item.name?.trim());
          if (first && !latest.collectionId && !latest.regions.collection.loading) void store.openCollection(first.id);
        });
      }
      if (tab === "tasks" && !state.regions.runs.data && !state.regions.runs.loading) void store.loadHistory("runs");
      if (tab === "changes") {
        if (!state.regions.runs.data && !state.regions.runs.loading) void store.loadHistory("runs");
        if (!state.regions.plans.data && !state.regions.plans.loading) void store.loadHistory("plans");
      }
      if (tab === "account" && !state.account && !state.regions.account.loading) void store.loadAccount();
    }
    function BrandGlyph() {
      return h(
        "svg",
        { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
        h("rect", { x: 2.5, y: 3.5, width: 19, height: 17, rx: 4, stroke: "currentColor", strokeWidth: 1.5 }),
        h("circle", { cx: 8, cy: 9, r: 1.5, fill: "currentColor" }),
        h("path", { d: "m5 17 4.5-4.5 3 3L16 11l3 6", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" })
      );
    }
    function ImageSkeleton() {
      return h("div", { className: "afp-wb-gallery afp-wb-skeleton-grid", "aria-hidden": true }, ...Array.from({ length: 6 }, (_, index) => h(Gallery.PhotoSkeleton, { key: index })));
    }
    function SearchPanel({ state }) {
      const region = state.regions.search, data = region.data;
      const loadingMore = region.loading && region.loadMode === "more";
      const searching = region.loading && !loadingMore;
      const credentials = state.account?.credentials;
      const accountMissing = credentials && !credentials.accessTokenRef?.configured && !(credentials.usernameRef?.configured && credentials.passwordRef?.configured);
      const submit = (event) => {
        event.preventDefault();
        void store.searchPhotos();
      };
      const count = Object.keys(state.selectedPhotos).length;
      const canAdd = count > 0 && count <= 120 && !state.busy && !state.collectionSelecting && state.status?.features?.includes("read") && state.status?.features?.includes("write");
      const addButton = h(
        Button,
        {
          variant: "ghost",
          size: "sm",
          className: "afp-wb-collection-action",
          disabled: !canAdd,
          "aria-label": t("addFavorites"),
          onClick: () => store.openAddFavorites()
        },
        icons.IconFolderOpenOutlineRegular ? h(icons.IconFolderOpenOutlineRegular, { size: 17 }) : null
      );
      return h(
        "div",
        { className: "afp-wb-panel-content afp-wb-search-layout", "aria-busy": region.loading },
        h(
          "form",
          { className: "afp-wb-search-toolbar", onSubmit: submit },
          h(SearchInput, { value: state.queryDraft, enabled: state.tab === "search", onChange: (queryDraft) => store.set({ queryDraft }) }),
          h(Selector, {
            className: "afp-wb-language",
            value: state.language,
            label: t("searchLanguage"),
            options: [{ value: "", label: t("deploymentDefault") }, ...["en", "fr", "es", "ar", "de", "pt"].map((language) => ({ value: language, label: t(`language_${language}`) }))],
            onChange: (language) => store.set({ language })
          }),
          h(Button, {
            variant: "primary",
            type: "submit",
            "aria-busy": searching,
            disabled: !state.queryDraft.trim() || searching || !state.status?.features?.includes("read"),
            icon: searching ? h(UI.StateDot, { state: "ongoing", size: 14 }) : icons.IconSearchOutlineRegular ? h(icons.IconSearchOutlineRegular, { size: 16 }) : null
          }, t("search"))
        ),
        data || Object.keys(state.selectedPhotos).length ? h(
          "div",
          { className: "afp-wb-result-bar" },
          h("p", null, data ? `${t("showingPhotos")} ${data.items.length}` : ""),
          h(
            "div",
            { className: "afp-wb-actions" },
            h(
              Button,
              {
                variant: state.selectionOpen ? "outline" : "ghost",
                size: "sm",
                "aria-expanded": state.selectionOpen,
                onClick: () => store.set({ selectionOpen: !state.selectionOpen })
              },
              t("selectionList"),
              h(Tag, { tone: "quiet" }, String(count))
            ),
            Tooltip ? h(Tooltip, { label: t(count > 120 ? "favoritesSelectionLimit" : !state.status?.features?.includes("write") ? "favoritesPermissionsRequired" : "addFavorites"), side: "top", portal: true }, addButton) : addButton
          )
        ) : null,
        region.error && region.loadMode !== "more" ? h(
          "div",
          { className: "afp-wb-error-row", role: "alert" },
          h("span", null, t("regionReadFailed")),
          h(Button, { variant: "ghost", size: "sm", onClick: () => {
            void store.searchPhotos();
          } }, t("retry"))
        ) : null,
        !data && region.loading ? h(ImageSkeleton) : null,
        !data && !region.loading && !region.error && !state.selectionOpen ? h(
          "div",
          { className: "afp-wb-empty-block" },
          h("span", { className: "afp-wb-empty-icon", "aria-hidden": true }, h(BrandGlyph)),
          h("p", null, t(accountMissing ? "accountRequired" : "searchPrompt")),
          accountMissing || !state.status?.features?.includes("read") ? h(Button, { variant: "outline", size: "sm", onClick: () => handleTab("account") }, t("openAccountSettings")) : null
        ) : null,
        data && !data.items.length && !region.loading && !region.error && !state.selectionOpen && !state.detail ? h(
          "div",
          { className: "afp-wb-empty-block", role: "status" },
          h("span", { className: "afp-wb-empty-icon", "aria-hidden": true }, icons.IconSearchOutlineRegular ? h(icons.IconSearchOutlineRegular, { size: 24 }) : h(BrandGlyph)),
          h("p", null, t("noPhotos"))
        ) : null,
        data || state.selectionOpen || state.detail ? h(
          "div",
          { className: `afp-wb-gallery-layout${state.selectionOpen || state.detail ? " is-with-aside" : ""}` },
          data ? h(
            "div",
            { className: "afp-wb-gallery-wrap" },
            h(Gallery.PhotoGrid, { items: data.items, selectedPhotos: state.selectedPhotos, loading: loadingMore }),
            region.error && region.loadMode === "more" ? h(
              "div",
              { className: "afp-wb-error-row", role: "alert" },
              h("span", null, t("loadMoreFailed")),
              h(Button, { variant: "ghost", size: "sm", onClick: () => {
                void store.searchPhotos({ more: true });
              } }, t("retry"))
            ) : null,
            data.hasMore && !region.error ? h("div", { className: "afp-wb-load-row" }, h(Button, {
              variant: "outline",
              disabled: region.loading,
              "aria-busy": region.loading,
              icon: region.loading ? h(UI.StateDot, { state: "ongoing", size: 14 }) : null,
              onClick: () => {
                void store.searchPhotos({ more: true });
              }
            }, t("loadMore"))) : null,
            loadingMore ? h("span", { className: "afp-wb-visually-hidden", role: "status" }, t("loading")) : null,
            data.paginationStopped ? h("p", { className: "afp-wb-pagination-note", role: "status" }, t("paginationPaused")) : null
          ) : null,
          state.selectionOpen ? h(Gallery.SelectionPane, { photos: Object.values(state.selectedPhotos), onOpen: (photo) => {
            void store.openPhoto(photo);
            store.set({ selectionOpen: false });
          } }) : state.detail && state.tab === "search" ? h(Gallery.DetailPane, { photo: state.detail, loading: state.regions.detail.loading, error: state.regions.detail.error, onClose: () => store.closePhoto() }) : null
        ) : null
      );
    }
    function CollectionSelectionActions({ state }) {
      const selected = Object.values(state.selectedPhotos);
      const allSelected = store.isCollectionFullySelected();
      const bulkLabel = state.collectionSelecting ? "cancelSelectAll" : allSelected ? "deselectCollection" : "selectAllCollection";
      const page = state.regions.collection;
      const sources = state.photoSources ?? {};
      const collections = state.regions.collections.data?.items ?? [];
      const writable = collections.filter((item) => item.name?.trim() && !item.readOnly);
      const writeEnabled = state.status?.features?.includes("write");
      const canRemove = writeEnabled && selected.length > 0 && selected.every((photo) => {
        const ids = sources[photo.id] ?? [];
        return ids.length > 0 && ids.every((id) => collections.some((item) => item.id === id && !item.readOnly));
      });
      const canTransfer = writeEnabled && writable.length > 0 && selected.length > 0;
      const canDownload = state.status?.features?.includes("read") && selected.length > 0 && selected.length <= 120;
      const action = (key, iconName, enabled, value) => {
        const Icon = icons[iconName];
        const button = h(Button, {
          variant: "ghost",
          size: "sm",
          className: "afp-wb-collection-action",
          disabled: !enabled || state.collectionSelecting,
          "aria-label": t(key),
          onClick: () => store.set({ collectionAction: value })
        }, Icon ? h(Icon, { size: 17 }) : null);
        return Tooltip ? h(Tooltip, { key, label: t(key === "downloadSelection" && selected.length > 120 ? "downloadSelectionLimit" : key), side: "top", portal: true }, button) : button;
      };
      return h(
        "div",
        { className: "afp-wb-collection-selection", role: "group", "aria-label": t("selectionList") },
        h(Button, {
          variant: allSelected ? "outline" : "ghost",
          size: "sm",
          className: "afp-wb-select-all",
          disabled: !state.status?.features?.includes("read") || !state.collectionId || page.loading || !page.data?.total || state.busy || Boolean(state.collectionAction),
          "aria-pressed": allSelected,
          "aria-busy": state.collectionSelecting,
          icon: state.collectionSelecting ? h(StateDot, { state: "ongoing", size: 14 }) : icons.IconCheckOutlineRegular ? h(icons.IconCheckOutlineRegular, { size: 14 }) : null,
          onClick: () => {
            void store.toggleCollectionSelection();
          }
        }, t(bulkLabel)),
        h(
          Button,
          {
            variant: "outline",
            size: "sm",
            className: "afp-wb-selection-summary",
            "aria-label": `${t("selectionList")} \xB7 ${t("selectedPhotoCount").replace("{count}", String(selected.length))}`,
            "aria-expanded": state.selectionOpen,
            onClick: () => store.set({ selectionOpen: !state.selectionOpen })
          },
          selected.length ? h(
            "span",
            { className: "afp-wb-selection-thumbnails", "aria-hidden": true },
            ...selected.slice(0, 3).map((photo) => h("span", { className: "afp-wb-selection-thumbnail", key: photo.id }, h(Gallery.ImagePreview, { photo, retry: false }))),
            selected.length > 3 ? h("span", { className: "afp-wb-selection-overflow" }, `+${selected.length - 3}`) : null
          ) : null,
          h("span", { className: "afp-wb-selection-label" }, t("selectionList")),
          h(Tag, { tone: selected.length ? "info" : "neutral", className: "afp-wb-selection-count" }, String(selected.length)),
          icons.IconChevronDownOutlineRegular ? h(icons.IconChevronDownOutlineRegular, { size: 14, className: "afp-wb-selection-chevron" }) : null
        ),
        h(
          "div",
          { className: "afp-wb-collection-actions" },
          action("downloadSelection", "IconDownloadOutlineRegular", canDownload, "download"),
          action("removeSelection", "IconTrashOutlineRegular", canRemove, "remove"),
          action("transferSelection", "IconFolderOpenOutlineRegular", canTransfer, "transfer")
        )
      );
    }
    function CollectionActionDialogs({ state }) {
      const [transferMode, setTransferMode] = React.useState("copy");
      const [targetCollectionId, setTargetCollectionId] = React.useState("");
      const action = state.collectionAction;
      const photos = Object.values(state.selectedPhotos);
      const collections = state.regions.collections.data?.items ?? [];
      const writable = collections.filter((item) => item.name?.trim() && !item.readOnly);
      const sources = state.photoSources ?? {};
      const canMove = photos.length > 0 && photos.every((photo) => {
        const ids = sources[photo.id] ?? [];
        return ids.length > 0 && ids.every((id) => collections.some((item) => item.id === id && !item.readOnly));
      });
      const targets = writable.filter((item) => transferMode === "copy" || !photos.some((photo) => (sources[photo.id] ?? []).includes(item.id)));
      React.useEffect(() => {
        if (action === "transfer") {
          setTransferMode("copy");
          setTargetCollectionId("");
        }
      }, [action]);
      const close = () => store.set({ collectionAction: null, collectionActionResult: null, downloadError: "", downloadPlan: null, downloadQuoteChanged: false });
      const selectionRows = h("div", { className: "afp-wb-action-summary" }, h("strong", null, t("selectedPhotoCount").replace("{count}", String(photos.length))));
      const footer = (...children) => h("div", { className: "afp-wb-dialog-footer" }, ...children);
      const transferDisabled = state.busy || !targetCollectionId || transferMode === "move" && !canMove;
      const submitTransfer = () => {
        void store.submitCollectionOperation(transferMode, targetCollectionId);
      };
      const submitRemove = () => {
        void store.submitCollectionOperation("remove");
      };
      const removeBody = h(
        "div",
        { className: "afp-wb-operation-dialog" },
        selectionRows,
        h("p", null, t("removeFavoritesWarning")),
        state.collectionActionResult ? h(
          "div",
          { className: "afp-wb-operation-result", role: "status" },
          h("strong", null, t("operationResult").replace("{count}", String(state.collectionActionResult.completed ?? 0))),
          h("p", null, `${t("partial")}: ${state.collectionActionResult.partial ?? 0} \xB7 ${t("failed")}: ${state.collectionActionResult.failed ?? 0} \xB7 ${t("pending")}: ${state.collectionActionResult.pending ?? 0}`)
        ) : null,
        state.downloadError ? h("p", { className: "afp-wb-error-row", role: "alert" }, t("collectionActionFailed")) : null
      );
      const transferBody = h(
        "div",
        { className: "afp-wb-operation-dialog" },
        selectionRows,
        h("div", { className: "afp-wb-transfer-mode" }, ...["copy", "move"].map((mode) => h(Button, {
          key: mode,
          variant: transferMode === mode ? "primary" : "outline",
          size: "sm",
          disabled: mode === "move" && !canMove || state.busy,
          onClick: () => {
            setTransferMode(mode);
            setTargetCollectionId("");
          }
        }, t(mode)))),
        transferMode === "move" && !canMove ? h("p", { className: "afp-wb-subtle" }, t("moveSourceRequired")) : null,
        h(
          "div",
          { className: "afp-wb-dialog-field" },
          h("span", null, t("targetCollection")),
          h(Selector, {
            value: targetCollectionId,
            label: t("targetCollection"),
            disabled: !targets.length || state.busy,
            options: [{ value: "", label: t("chooseTarget"), disabled: true }, ...targets.map((item) => ({ value: item.id, label: item.name }))],
            onChange: setTargetCollectionId
          })
        ),
        state.collectionActionResult ? h(
          "div",
          { className: "afp-wb-operation-result", role: "status" },
          h("strong", null, t("operationResult").replace("{count}", String(state.collectionActionResult.completed ?? 0))),
          h("p", null, `${t("partial")}: ${state.collectionActionResult.partial ?? 0} \xB7 ${t("failed")}: ${state.collectionActionResult.failed ?? 0} \xB7 ${t("pending")}: ${state.collectionActionResult.pending ?? 0}`)
        ) : null,
        state.downloadError ? h("p", { className: "afp-wb-error-row", role: "alert" }, t("collectionActionFailed")) : null
      );
      return h(
        React.Fragment,
        null,
        h(DownloadDialog, { state, onAccount: () => handleTab("account"), onTasks: () => handleTab("tasks") }),
        Modal ? h(Modal, {
          open: action === "remove",
          onClose: close,
          title: t("removeFavoritesTitle"),
          closeLabel: t("close"),
          className: "afp-wb-action-modal",
          contentClassName: "afp-wb-action-modal-content",
          footer: footer(
            h(Button, { variant: "ghost", onClick: close, disabled: state.busy }, t("cancel")),
            state.collectionActionResult ? h(Button, { variant: "primary", onClick: close }, t("close")) : h(Button, {
              variant: "primary",
              disabled: state.busy,
              onClick: submitRemove
            }, state.busy ? t("working") : t("removeFromFavorites"))
          )
        }, removeBody) : null,
        Modal ? h(Modal, {
          open: action === "transfer",
          onClose: close,
          title: t("transferSelectionTitle"),
          closeLabel: t("close"),
          className: "afp-wb-action-modal",
          contentClassName: "afp-wb-action-modal-content",
          footer: footer(
            h(Button, { variant: "ghost", onClick: close, disabled: state.busy }, t("cancel")),
            state.collectionActionResult ? h(Button, { variant: "primary", onClick: close }, t("close")) : h(Button, {
              variant: "primary",
              disabled: transferDisabled,
              onClick: submitTransfer
            }, state.busy ? t("working") : t("confirmTransfer"))
          )
        }, transferBody) : null
      );
    }
    function CollectionsPanel({ state }) {
      const list = state.regions.collections, page = state.regions.collection;
      const selected = page.data?.collection ?? list.data?.items?.find((item) => item.id === state.collectionId);
      const [collapsed, setCollapsed] = React.useState(false);
      const [showTop, setShowTop] = React.useState(false);
      const scroller = React.useRef(null), toggle = React.useRef(null);
      const sidebarId = React.useId();
      const name = (item) => item?.name?.trim() || t("unnamedCollection");
      const filtered = (list.data?.items ?? []).filter((item) => item.name?.trim() && name(item).toLowerCase().includes(state.collectionFilter.toLowerCase()));
      const toggleButton = h(
        Button,
        {
          ref: toggle,
          variant: "ghost",
          size: "sm",
          className: "afp-wb-sidebar-toggle",
          "aria-label": t(collapsed ? "expandCollections" : "collapseCollections"),
          "aria-expanded": !collapsed,
          "aria-controls": sidebarId,
          onClick: () => {
            toggle.current?.focus();
            setCollapsed((value) => !value);
          }
        },
        icons.IconPanelLeftOutlineRegular ? h(icons.IconPanelLeftOutlineRegular, { size: 18 }) : h(
          "svg",
          { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
          h("rect", { x: 3, y: 4, width: 18, height: 16, rx: 3, stroke: "currentColor", strokeWidth: 1.5 }),
          h("path", { d: "M9 4v16", stroke: "currentColor", strokeWidth: 1.5 })
        )
      );
      React.useEffect(() => {
        if (scroller.current) scroller.current.scrollTop = 0;
        setShowTop(false);
      }, [state.collectionId]);
      const backToTop = () => {
        const target = scroller.current;
        if (!target) return;
        target.focus({ preventScroll: true });
        target.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
      };
      return h(
        "div",
        { className: "afp-wb-collections-layout" + (collapsed ? " is-sidebar-collapsed" : "") },
        h(
          "div",
          { className: "afp-wb-collection-controls" },
          h(
            "div",
            { className: "afp-wb-collection-filter-slot", hidden: collapsed },
            h(Input, {
              className: "afp-wb-input afp-wb-filter",
              value: state.collectionFilter,
              placeholder: t("filterCollections"),
              "aria-label": t("filterCollections"),
              icon: icons.IconSearchOutlineRegular ? h(icons.IconSearchOutlineRegular, { size: 16 }) : null,
              onChange: (event) => store.set({ collectionFilter: event.target.value })
            })
          ),
          Tooltip ? h(Tooltip, { label: t(collapsed ? "expandCollections" : "collapseCollections"), side: "top", portal: true }, toggleButton) : toggleButton
        ),
        h(
          "aside",
          { id: sidebarId, className: "afp-wb-collection-sidebar", inert: collapsed ? "" : void 0, "aria-hidden": collapsed },
          h("div", { className: "afp-wb-collection-directory-heading" }, h("span", null, t("tab_collections")), h(Tag, { tone: "quiet" }, String(filtered.length))),
          list.error ? h("div", { role: "alert", className: "afp-wb-error-row" }, t("regionReadFailed"), h(Button, { variant: "ghost", size: "sm", onClick: () => {
            void store.loadCollections();
          } }, t("retry"))) : null,
          list.loading && !list.data ? h(
            "div",
            { className: "afp-wb-collection-skeleton", role: "status", "aria-label": t("loading") },
            ...Array.from({ length: 8 }, (_, index) => h("span", { key: index, className: "afp-skeleton" }))
          ) : null,
          h(
            "nav",
            { className: "afp-wb-collection-list", "aria-label": t("tab_collections") },
            GlideHighlight ? h(GlideHighlight, { className: "afp-wb-collection-glide", rowSelector: ".afp-wb-collection-item" }) : null,
            ...filtered.map((item) => h(
              Button,
              {
                variant: "ghost",
                size: "sm",
                key: item.id,
                className: "afp-wb-collection-item" + (state.collectionId === item.id ? " is-selected" : ""),
                title: name(item),
                "aria-label": [
                  name(item),
                  t(item.readOnly ? item.isPrivate ? "readOnly" : "sharedReadOnly" : "private"),
                  item.count == null ? "" : `${t("documentCount")} ${item.count}`
                ].filter(Boolean).join(" \xB7 "),
                "aria-pressed": state.collectionId === item.id,
                onClick: () => {
                  void store.openCollection(item.id);
                }
              },
              icons.IconFolderCloseRegular ? h(icons.IconFolderCloseRegular, { size: 16, "aria-hidden": true }) : null,
              h("span", { className: "afp-wb-collection-name" }, name(item)),
              item.readOnly ? h(Tag, { tone: "quiet" }, t(item.isPrivate ? "readOnly" : "sharedReadOnly")) : null,
              item.count !== null && item.count !== void 0 ? h("span", { className: "afp-wb-collection-count", "aria-hidden": true }, h(Tag, { tone: "quiet" }, String(item.count))) : null
            ))
          ),
          !list.loading && !list.error && list.data && !filtered.length ? h("p", { className: "afp-wb-empty" }, t("noCollections")) : null
        ),
        h(
          "div",
          { className: "afp-wb-collection-content" },
          h(
            "div",
            { className: "afp-wb-section-heading afp-wb-collection-heading" },
            h(
              "div",
              { className: "afp-wb-collection-heading-left" },
              h(
                "div",
                null,
                h("h3", null, selected ? name(selected) : t("selectCollection")),
                selected ? h("p", { className: "afp-wb-subtle" }, t(selected.readOnly ? selected.isPrivate ? "readOnly" : "sharedReadOnly" : "private") + (page.data ? " \xB7 " + t("photoCount") + ": " + page.data.total : "")) : null
              )
            ),
            h(CollectionSelectionActions, { state })
          ),
          state.collectionSelectionError ? h(
            "div",
            { className: "afp-wb-error-row", role: "alert" },
            t("selectAllFailed"),
            h(Button, { variant: "ghost", size: "sm", onClick: () => {
              void store.toggleCollectionSelection();
            } }, t("retry"))
          ) : null,
          page.error ? h(
            "div",
            { className: "afp-wb-error-row", role: "alert" },
            t(page.loadMode === "more" ? "loadMoreFailed" : "regionReadFailed"),
            h(Button, { variant: "ghost", size: "sm", onClick: () => {
              if (state.collectionId) void (page.loadMode === "more" ? store.loadMoreCollection() : store.openCollection(state.collectionId));
            } }, t("retry"))
          ) : null,
          h(
            "div",
            { className: "afp-wb-collection-stage" },
            h(
              "div",
              { className: "afp-wb-gallery-layout" + (state.selectionOpen || state.detail ? " is-with-aside" : "") },
              h(
                "div",
                {
                  ref: scroller,
                  className: "afp-wb-gallery-wrap afp-wb-collection-scroll",
                  tabIndex: -1,
                  role: "region",
                  "aria-label": t("collectionPhotos"),
                  "aria-busy": page.loading,
                  onScroll: (event) => setShowTop(event.currentTarget.scrollTop > event.currentTarget.clientHeight / 2)
                },
                page.loading && !page.data ? h(ImageSkeleton) : null,
                page.data ? h(Gallery.PhotoGrid, { items: page.data.items, selectedPhotos: state.selectedPhotos, sourceCollectionId: state.collectionId, loading: page.loading && page.loadMode === "more" }) : null,
                page.data?.hasMore && !page.error ? h("div", { className: "afp-wb-load-row" }, h(Button, {
                  variant: "outline",
                  disabled: page.loading,
                  "aria-busy": page.loading,
                  icon: page.loading ? h(StateDot, { state: "ongoing", size: 14 }) : null,
                  onClick: () => {
                    void store.loadMoreCollection();
                  }
                }, t("loadMore"))) : null,
                page.data?.paginationStopped ? h("p", { className: "afp-wb-pagination-note", role: "status" }, t("paginationPaused")) : null,
                !page.data && !page.loading && !page.error && !list.error ? h("p", { className: "afp-wb-empty" }, t("collectionPrompt")) : null
              ),
              state.selectionOpen ? h(Gallery.SelectionPane, { photos: Object.values(state.selectedPhotos), onOpen: (photo) => {
                void store.openPhoto(photo);
                store.set({ selectionOpen: false });
              } }) : state.detail && state.tab === "collections" ? h(Gallery.DetailPane, { photo: state.detail, loading: state.regions.detail.loading, error: state.regions.detail.error, sourceCollectionId: state.collectionId, onClose: () => store.closePhoto() }) : null
            ),
            showTop ? h(
              Button,
              { variant: "outline", size: "sm", className: "afp-wb-back-top", onClick: backToTop, "aria-label": t("backToTop") },
              h(
                "svg",
                { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
                h("path", { d: "m6 12 6-6 6 6M12 6v13", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" })
              )
            ) : null
          ),
          h(CollectionActionDialogs, { state })
        )
      );
    }
    function AccountProfile({ state }) {
      const region = state.regions.profile, user = region.data;
      const configured = state.account?.token?.configured;
      const ready = configured && state.status?.features?.includes("read");
      const display = (value) => value || t("notAvailable");
      const field = (key, value) => h("div", { key }, h("dt", null, t(key)), h("dd", null, display(value)));
      return h(
        "aside",
        { className: "afp-wb-user-profile", "aria-label": t("accountInformation"), "aria-busy": region.loading },
        h(
          "div",
          { className: "afp-wb-section-heading" },
          h("h3", null, t("accountInformation")),
          h(
            Tooltip,
            { label: t("refreshAccount"), portal: true, maxWidth: 180 },
            h(
              Button,
              {
                variant: "ghost",
                size: "sm",
                disabled: !ready || region.loading,
                "aria-busy": region.loading,
                onClick: () => {
                  void store.loadProfile();
                },
                "aria-label": t("refreshAccount")
              },
              region.loading ? h(UI.StateDot, { state: "ongoing", size: 14 }) : icons.IconRefreshOutlineRegular ? h(icons.IconRefreshOutlineRegular, { size: 16 }) : t("refresh")
            )
          )
        ),
        region.loading && !user ? h(
          "div",
          { className: "afp-wb-profile-skeleton", role: "status", "aria-label": t("loading") },
          ...Array.from({ length: 5 }, (_, index) => h("span", { className: "afp-skeleton", key: index }))
        ) : null,
        region.error ? h(
          "div",
          { className: "afp-wb-profile-error", role: "alert" },
          h("p", null, t("accountReadFailed")),
          h(Button, { variant: "outline", size: "sm", disabled: !ready || region.loading, onClick: () => {
            void store.loadProfile();
          } }, t("retry"))
        ) : null,
        user ? h(
          React.Fragment,
          null,
          h(
            "div",
            { className: "afp-wb-user-identity" },
            h("span", { className: "afp-wb-user-avatar", "aria-hidden": true }, (user.firstName || user.login || "A").slice(0, 1).toUpperCase()),
            h("div", null, h("h4", null, [user.firstName, user.lastName].filter(Boolean).join(" ") || display(user.login)), h("p", null, display(user.login)))
          ),
          h("div", { className: "afp-wb-user-credit" }, h("span", null, t("creditBalance")), h("strong", null, user.credit == null ? t("notAvailable") : String(user.credit))),
          h("dl", { className: "afp-wb-user-fields" }, field("accountEmail", user.email), field("accountId", user.id), field("clientId", user.clientId)),
          user.subjectToCredit !== null ? h("p", { className: "afp-wb-subtle" }, t(user.subjectToCredit ? "creditBilling" : "subscriptionBilling")) : null
        ) : null,
        !user && !region.loading && !region.error ? h("p", { className: "afp-wb-subtle" }, t(configured ? "enableReadForAccount" : "loginToViewAccount")) : null
      );
    }
    function FeatureTile({ feature, state }) {
      const [expanded, setExpanded] = React.useState(false);
      const [failedIcon, setFailedIcon] = React.useState("");
      const detailsId = React.useId();
      const title = ctx.locale.resolveText(feature.title);
      const status = feature.running ? "running" : feature.enabled ? "selected" : "unselected";
      const Icon = icons[{ script: "IconCodeOutlineRegular", skill: "IconSkillOutlineRegular", ui: "IconPanelLeftOutlineRegular" }[feature.kind]];
      const Chevron = icons.IconChevronDownOutlineRegular;
      return h(
        "div",
        { className: `afp-wb-feature-tile${expanded ? " is-expanded" : ""}` },
        h(
          "div",
          { className: "afp-wb-feature-line" },
          h("span", { className: "afp-wb-feature-icon", "aria-hidden": true }, feature.icon && failedIcon !== feature.icon ? h(
            "span",
            { className: "afp-wb-feature-artwork", style: { maskImage: `url("${feature.icon}")`, WebkitMaskImage: `url("${feature.icon}")` } },
            h("img", { src: feature.icon, alt: "", onError: () => setFailedIcon(feature.icon) })
          ) : Icon ? h(Icon, { size: 18 }) : null),
          h(
            "div",
            { className: "afp-wb-feature-identity" },
            h("button", {
              type: "button",
              className: "afp-wb-feature-title",
              "aria-expanded": expanded,
              "aria-controls": detailsId,
              onClick: () => setExpanded((current) => !current)
            }, h("span", null, title), Chevron ? h(Chevron, { size: 12 }) : null),
            h("span", { className: "afp-wb-feature-status", "data-state": status }, h("span", { className: "afp-wb-feature-dot", "aria-hidden": true }), t(status))
          ),
          h(Switch, {
            checked: state.pendingTargets[feature.id] ?? feature.enabled,
            label: title,
            loading: state.saving.includes(feature.id),
            onChange: (next) => {
              void store.toggle(feature.id, next);
            }
          })
        ),
        h(
          "div",
          { id: detailsId, className: "afp-wb-feature-details", "aria-hidden": !expanded },
          h("div", { className: "afp-wb-feature-details-inner" }, h("p", null, ctx.locale.resolveText(feature.description)))
        )
      );
    }
    function AccountPanel({ state }) {
      const account = state.account;
      const [section, setSection] = React.useState("credentials");
      const sectionId = React.useId();
      const featureKinds = ["script", "skill", "ui"];
      React.useEffect(() => {
        const region = state.regions.profile;
        if (state.tab === "account" && section === "credentials" && state.account?.token?.configured && state.status?.features?.includes("read") && !region.data && !region.loading && !region.error) void store.loadProfile();
      }, [state.tab, section, state.account, state.status, state.regions.profile]);
      const saveDone = () => {
        void store.resetAndReload();
      };
      const featureGroups = featureKinds.map((kind) => {
        const features = (state.features ?? []).filter((feature) => feature.kind === kind);
        if (!features.length) return null;
        return h(
          "section",
          { key: kind, className: "afp-wb-feature-group" },
          h("div", { className: "afp-wb-feature-group-heading" }, h("h4", null, t(kind)), h(Tag, { tone: "quiet" }, String(features.length))),
          h("div", { className: "afp-wb-feature-grid" }, ...features.map((feature) => h(FeatureTile, { key: feature.id, feature, state })))
        );
      });
      return h(
        "div",
        { className: "afp-wb-account-layout" },
        h(
          "div",
          { className: "afp-wb-account-nav" },
          h(SegmentedControl, {
            id: sectionId,
            value: section,
            label: t("accountSections"),
            className: "afp-wb-account-segments",
            options: ["credentials", "vision", "features"].map((value) => ({ value, label: t(`accountSection_${value}`) })),
            onChange: setSection
          }),
          account?.profile ? h("span", { className: "afp-wb-subtle afp-wb-account-profile" }, `${t("profile")} \xB7 ${account.profile}`) : null
        ),
        state.regions.account.error ? h("div", { className: "afp-wb-error-row", role: "alert" }, t("regionReadFailed"), h(Button, { variant: "ghost", size: "sm", onClick: () => {
          void store.loadAccount();
        } }, t("retry"))) : null,
        // 表单保持挂载；切换分区不会丢失尚未保存的账号、密钥或模型草稿。
        h(
          "div",
          { className: "afp-wb-account-body" + (section === "credentials" ? " is-credentials" : "") },
          h(ConfigurationForm, { view: "page", className: "afp-wb-config-form", section, sectionId, onSaved: saveDone }),
          h("div", { hidden: section !== "credentials", className: "afp-wb-profile-slot" }, h(AccountProfile, { state }))
        ),
        h(
          "section",
          { role: "tabpanel", id: `${sectionId}-features-panel`, "aria-labelledby": `${sectionId}-features`, hidden: section !== "features", className: "afp-wb-feature-section" },
          h("div", { className: "afp-wb-feature-groups" }, ...featureGroups)
        )
      );
    }
    return function AfpWorkbench() {
      const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      const id = React.useId();
      const keydown = (event, index) => {
        const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault();
        handleTab(tabs[next]);
        const target = event.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next];
        target?.focus();
        target?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      };
      const renderTab = (tab, index) => {
        const selected = state.tab === tab;
        const iconsByTab = { search: "IconSearchOutlineRegular", collections: "IconFolderCloseRegular", tasks: "IconFlatListOutlineRegular", changes: "IconRefreshOutlineRegular", account: "IconSettingsOutlineRegular" };
        const Icon = icons[iconsByTab[tab]];
        return h(
          "button",
          {
            type: "button",
            role: "tab",
            id: `${id}-tab-${tab}`,
            key: tab,
            "aria-selected": selected,
            "aria-controls": `${id}-panel-${tab}`,
            tabIndex: selected ? 0 : -1,
            className: `afp-wb-tab${selected ? " is-active" : ""}`,
            onClick: () => handleTab(tab),
            onKeyDown: (event) => keydown(event, index)
          },
          Icon ? h(Icon, { size: 16 }) : null,
          t(`tab_${tab}`)
        );
      };
      const renderPanel = (tab, content) => h("section", {
        role: "tabpanel",
        id: `${id}-panel-${tab}`,
        "aria-labelledby": `${id}-tab-${tab}`,
        className: `afp-wb-tabpanel afp-wb-panel-${tab}`,
        hidden: state.tab !== tab,
        key: tab
      }, content);
      const tokenExpired = state.account?.token?.expiresAt != null && state.account.token.expiresAt <= Date.now();
      return h(
        "main",
        { className: "afp-workbench afp-wb-root", onKeyDown: (event) => {
          if (event.target.closest?.('[role="dialog"]') || event.key !== "Escape" || !state.detail && !state.selectionOpen) return;
          event.stopPropagation();
          store.closePhoto();
          store.set({ selectionOpen: false });
        } },
        h(
          "header",
          { className: "afp-wb-header" },
          h("div", { className: "afp-wb-brand" }, h(BrandGlyph), h("h1", null, t("workbenchTitle"))),
          h(
            "div",
            { className: "afp-wb-header-actions" },
            state.account?.username ? h("span", { className: "afp-wb-profile" }, state.account.username) : null,
            state.account ? h(Tag, { tone: tokenExpired ? "warning" : state.account.token?.verifiedAt ? "success" : "neutral" }, t(tokenExpired ? "tokenExpired" : state.account.token?.verifiedAt ? "tokenVerified" : state.account.token?.configured ? "tokenUnverified" : "missing")) : state.regions.account.error ? h("span", { className: "afp-wb-subtle" }, t("accountUnavailable")) : h("span", { className: "afp-skeleton afp-skeleton-label", "aria-label": t("loading") })
          )
        ),
        state.error ? h("p", { className: "afp-wb-global-error", role: "alert" }, t("operationFailed")) : null,
        h("div", { className: "afp-wb-tabstrip", role: "tablist", "aria-label": t("workbenchTabs") }, ...tabs.map(renderTab)),
        h(
          "div",
          { className: `afp-wb-content afp-wb-content-${state.tab}` },
          renderPanel("search", h(SearchPanel, { state })),
          renderPanel("collections", h(CollectionsPanel, { state })),
          renderPanel("tasks", h(TaskPanels.TasksPanel, { state, onOpenAccount: () => handleTab("account"), onOpenChanges: (runId) => {
            store.set({ runId });
            handleTab("changes");
            void store.loadHistory("plans");
          } })),
          renderPanel("changes", h(TaskPanels.ChangesPanel, { state })),
          renderPanel("account", state.accountVisited ? h(AccountPanel, { state }) : null)
        ),
        h(AddFavoritesDialog, { state }),
        Toast && state.toast ? h(Toast, {
          key: `${state.toast}:${state.result?.taskId ?? state.result?.runId ?? ""}`,
          text: t(state.toast),
          tone: "success",
          holdMs: 4e3,
          onDone: () => store.set({ toast: "" })
        }) : null
      );
    };
  }

  // src/client/afp-preview-cache.js
  function aborted() {
    return new DOMException("Preview request aborted", "AbortError");
  }
  function createPreviewCache({
    load = readPreviewMedia,
    now = Date.now,
    createObjectURL = (blob) => URL.createObjectURL(blob),
    revokeObjectURL = (url) => URL.revokeObjectURL(url)
  } = {}) {
    const entries = /* @__PURE__ */ new Map(), pending = /* @__PURE__ */ new Map(), leased = /* @__PURE__ */ new Set(), jobs = /* @__PURE__ */ new Set();
    let policy = null, bytes2 = 0, generation = 0, disposed = false;
    let hits = 0, misses = 0, coalesced = 0;
    function revoke(entry) {
      if (!entry.url) return;
      revokeObjectURL(entry.url);
      entry.url = null;
      leased.delete(entry);
    }
    function drop(entry) {
      if (entries.get(entry.key) !== entry) return;
      entries.delete(entry.key);
      bytes2 -= entry.blob.size;
      entry.retained = false;
      if (!entry.refs) revoke(entry);
    }
    function prune() {
      for (const entry of entries.values()) if (entry.expiresAt <= now()) drop(entry);
      while (policy && (entries.size > policy.maxEntries || bytes2 > policy.maxBytes)) drop(entries.values().next().value);
    }
    function detach(waiter) {
      waiter.job.waiters.delete(waiter);
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
    }
    function stop(job) {
      if (pending.get(job.key) === job) pending.delete(job.key);
      job.controller.abort();
      for (const waiter of [...job.waiters]) {
        detach(waiter);
        waiter.reject(aborted());
      }
    }
    function clear() {
      generation++;
      for (const job of [...pending.values()]) stop(job);
      for (const entry of [...entries.values()]) drop(entry);
      for (const entry of [...leased]) revoke(entry);
    }
    function lease(entry, signal) {
      if (signal?.aborted || disposed) throw aborted();
      if (!entry.url) entry.url = createObjectURL(entry.blob);
      entry.refs++;
      leased.add(entry);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        signal?.removeEventListener("abort", release);
        entry.refs--;
        if (!entry.refs) {
          if (entry.retained && entry.expiresAt <= now()) drop(entry);
          revoke(entry);
        }
      };
      signal?.addEventListener("abort", release, { once: true });
      return { url: entry.url, release };
    }
    function launch(key) {
      const job = { key, generation, controller: new AbortController(), waiters: /* @__PURE__ */ new Set(), done: null };
      pending.set(key, job);
      job.done = Promise.resolve().then(() => {
        job.controller.signal.throwIfAborted();
        return load(key, job.controller.signal);
      }).then((blob) => {
        if (disposed || job.generation !== generation || job.controller.signal.aborted || pending.get(key) !== job) return;
        pending.delete(key);
        const entry = { key, blob, refs: 0, url: null, retained: false, expiresAt: now() + (policy?.ttlMs ?? 0) };
        if (policy && policy.maxEntries > 0 && blob.size <= policy.maxBytes) {
          entry.retained = true;
          entries.set(key, entry);
          bytes2 += blob.size;
          prune();
        }
        for (const waiter of [...job.waiters]) {
          detach(waiter);
          try {
            waiter.resolve(lease(entry, waiter.signal));
          } catch (error) {
            waiter.reject(error);
          }
        }
      }, (error) => {
        if (pending.get(key) === job) pending.delete(key);
        for (const waiter of [...job.waiters]) {
          detach(waiter);
          waiter.reject(error);
        }
      }).finally(() => jobs.delete(job.done));
      jobs.add(job.done);
      return job;
    }
    return {
      configure(next) {
        if (next !== null && (!next || typeof next.scope !== "string" || !next.scope || next.scope.length > 128 || !Number.isSafeInteger(next.maxEntries) || next.maxEntries < 0 || !Number.isSafeInteger(next.maxBytes) || next.maxBytes < 1 || !Number.isSafeInteger(next.ttlMs) || next.ttlMs < 1)) throw new Error("Invalid AFP preview cache policy");
        const value = next ? { scope: next.scope, maxEntries: next.maxEntries, maxBytes: next.maxBytes, ttlMs: next.ttlMs } : null;
        if (JSON.stringify(value) === JSON.stringify(policy)) return false;
        clear();
        policy = value;
        return true;
      },
      async acquire(src, signal, { refresh = false } = {}) {
        if (disposed || signal?.aborted) throw aborted();
        prune();
        if (refresh) this.invalidate(src);
        const entry = entries.get(src);
        if (entry) {
          hits++;
          entries.delete(src);
          entries.set(src, entry);
          return lease(entry, signal);
        }
        let job = pending.get(src);
        if (job) coalesced++;
        else {
          misses++;
          job = launch(src);
        }
        return new Promise((resolve, reject) => {
          const waiter = { job, signal, resolve, reject, onAbort: null };
          waiter.onAbort = () => {
            detach(waiter);
            reject(aborted());
            if (!job.waiters.size) stop(job);
          };
          job.waiters.add(waiter);
          signal?.addEventListener("abort", waiter.onAbort, { once: true });
        });
      },
      invalidate(src, url) {
        const entry = entries.get(src);
        if (entry && (url === void 0 || entry.url === url)) drop(entry);
      },
      clear,
      stats() {
        prune();
        return { entries: entries.size, bytes: bytes2, pending: pending.size, activeUrls: leased.size, hits, misses, coalesced };
      },
      async dispose() {
        disposed = true;
        clear();
        await Promise.allSettled([...jobs]);
      }
    };
  }

  // src/client/afp-client-store.js
  var NAME = "dsh-plugin-afp";
  var regionNames = ["account", "profile", "search", "collections", "collection", "runs", "plans", "run", "detail"];
  var emptyRegion = () => ({ data: null, loading: false, error: "" });
  function createAfpClientStore(ctx, options = {}) {
    const previews = createPreviewCache(options.previewCacheOptions);
    let state = {
      status: null,
      account: null,
      features: [],
      pendingTargets: {},
      saving: [],
      tab: "search",
      queryDraft: "",
      submittedQuery: "",
      language: "",
      submittedLanguage: "",
      regions: Object.fromEntries(regionNames.map((name) => [name, emptyRegion()])),
      collectionId: "",
      collectionFilter: "",
      selectedPhotos: {},
      photoSources: {},
      selectionOpen: false,
      detail: null,
      accountVisited: false,
      collectionSelecting: false,
      collectionSelectionError: "",
      collectionSelectionIds: [],
      collectionAction: null,
      collectionActionResult: null,
      favoritesRequest: null,
      favoritesBusy: false,
      favoritesError: "",
      favoritesResult: null,
      downloadOptions: null,
      downloadSelected: {},
      downloadOptionsLoading: false,
      downloadDirectory: null,
      downloadBulkResult: null,
      downloadPlan: null,
      downloadBusy: false,
      downloadBusyStage: "",
      downloadError: "",
      downloadErrorStage: "",
      downloadQuoteChanged: false,
      downloadResult: null,
      downloadDockOpen: false,
      downloadNotice: null,
      downloadCancellingId: "",
      runId: "",
      selected: ["food"],
      operation: "append",
      reportCategory: "",
      reportFilter: "all",
      targetPerCategory: null,
      threshold: null,
      plan: null,
      planFingerprint: "",
      confirmChecked: false,
      result: null,
      busy: false,
      error: "",
      toast: "",
      previewGeneration: 0
    };
    const listeners = /* @__PURE__ */ new Set();
    const sequences = Object.fromEntries(regionNames.map((name) => [name, 0]));
    const controllers = /* @__PURE__ */ new Map();
    let disposed = false, poll, reloadSequence = 0, featureQueue = Promise.resolve(), actionSequence = 0;
    let downloadSequence = 0, downloadController;
    let collectionSelectionSequence = 0;
    const searchCursors = /* @__PURE__ */ new Set();
    function publish(update) {
      if (disposed) return;
      state = { ...state, ...update };
      for (const listener of listeners) listener();
    }
    function set(update) {
      if (Object.hasOwn(update, "collectionAction") && update.collectionAction !== state.collectionAction) {
        downloadSequence++;
        downloadController?.abort();
        downloadController = null;
        update = { downloadOptionsLoading: false, downloadBusy: false, downloadBusyStage: "", downloadError: "", downloadErrorStage: "", downloadBulkResult: null, ...update };
      }
      const invalidate = ["runId", "selected", "operation"].some((key) => Object.hasOwn(update, key) && JSON.stringify(update[key]) !== JSON.stringify(state[key]));
      publish({ ...update, ...invalidate ? { plan: null, planFingerprint: "", confirmChecked: false } : {} });
    }
    async function call(operation, args = {}) {
      const result = await ctx.remote.pluginManager.invokeAction(NAME, "workbench", { operation, args: JSON.stringify(args) });
      if (!result.ok) throw new Error(result.error.message);
      return JSON.parse(result.value.output);
    }
    async function callData(operation, args = {}, signal) {
      const fetchImpl = options.fetchImpl ?? globalThis.fetch;
      const baseURI = options.baseURI ?? globalThis.document?.baseURI;
      if (typeof fetchImpl !== "function" || !baseURI) throw new Error("unavailable");
      const response = await fetchImpl(new URL("api/afp/workbench-data", baseURI), {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation, args }),
        signal
      });
      const payload = await response.json();
      if (!response.ok || payload?.ok !== true) throw new Error(payload?.error?.code ?? "unavailable");
      return payload.value;
    }
    function cancelCollectionSelection() {
      collectionSelectionSequence++;
      controllers.get("collection-selection")?.abort();
      controllers.delete("collection-selection");
      if (state.collectionSelecting || state.collectionSelectionError) publish({ collectionSelecting: false, collectionSelectionError: "" });
    }
    async function reload() {
      if (poll) return poll;
      const sequence = ++reloadSequence;
      const request = Promise.all([call("status"), ctx.remote.pluginManager.listBundles(), ctx.remote.pluginManager.listPlugins()]).then(([status, bundles, plugins]) => {
        if (!bundles.ok) throw new Error(bundles.error.message);
        if (!plugins.ok) throw new Error(plugins.error.message);
        const bundle = bundles.value.find((bundle2) => bundle2.name === NAME);
        if (bundle?.error) throw new Error(bundle.error.diagnostic ?? bundle.error.code);
        if (disposed || sequence !== reloadSequence) return;
        const readChanged = Boolean(state.status?.features?.includes("read")) !== status.features.includes("read");
        if (!status.features.includes("read")) cancelCollectionSelection();
        const priorScope = state.status?.previewCache?.scope;
        if (priorScope && status.previewCache?.scope && priorScope !== status.previewCache.scope) {
          store.resetData();
          void store.loadAccount();
        }
        const previewsChanged = previews.configure(status.features.includes("read") ? status.previewCache ?? null : null);
        if (readChanged && !previewsChanged) previews.clear();
        publish({
          status,
          ...status.downloads?.some((record) => record.id === state.downloadResult?.downloadId) ? { downloadResult: null } : {},
          ...previewsChanged || readChanged ? { previewGeneration: state.previewGeneration + 1 } : {},
          features: (bundle?.features ?? []).map((feature) => ({
            ...feature,
            running: plugins.value.some((row) => row.patchId === feature.rowId && row.enabled && row.fiberPhase === "active")
          })),
          ...status.features.includes("write") ? {} : { plan: null, planFingerprint: "", confirmChecked: false },
          error: ""
        });
      }).catch((error) => {
        if (!disposed && sequence === reloadSequence) publish({ error: error.message });
      }).finally(() => {
        if (poll === request) poll = null;
      });
      poll = request;
      return request;
    }
    function startRegion(name, { clearData = false, loadMode } = {}) {
      controllers.get(name)?.abort();
      const controller = new AbortController();
      controllers.set(name, controller);
      const sequence = ++sequences[name];
      publish({ regions: { ...state.regions, [name]: {
        ...state.regions[name],
        ...clearData ? { data: null } : {},
        ...loadMode ? { loadMode } : {},
        loading: true,
        error: ""
      } } });
      return { sequence, controller };
    }
    function finishRegion(name, sequence, data) {
      if (disposed || sequences[name] !== sequence) return false;
      publish({ regions: { ...state.regions, [name]: {
        data,
        loading: false,
        error: "",
        ...state.regions[name].loadMode ? { loadMode: "" } : {}
      } } });
      return true;
    }
    function failRegion(name, sequence, error) {
      if (disposed || sequences[name] !== sequence) return false;
      publish({ regions: { ...state.regions, [name]: { ...state.regions[name], loading: false, error: error.message } } });
      return false;
    }
    async function readRegion(name, operation, args) {
      const { sequence, controller } = startRegion(name);
      try {
        return finishRegion(name, sequence, await callData(operation, args, controller.signal));
      } catch (error) {
        return failRegion(name, sequence, error);
      } finally {
        if (controllers.get(name) === controller) controllers.delete(name);
      }
    }
    function dedupeItems(left = [], right = []) {
      const items = new Map(left.map((item) => [item.id, item]));
      for (const item of right) if (!items.has(item.id)) items.set(item.id, item);
      return [...items.values()];
    }
    function pageArgs(region, size) {
      return { offset: region?.data?.items?.length ?? 0, ...size ? { limit: size } : {} };
    }
    function currentDownload(sequence) {
      return !disposed && sequence === downloadSequence;
    }
    function changedDownloadQuote(result) {
      publish({
        downloadOptions: { ...state.downloadOptions, photos: result.photos, creditBalance: result.creditBalance },
        downloadSelected: Object.fromEntries(result.selected.map((item) => [item.photoId, item.renditionId])),
        downloadPlan: null,
        downloadQuoteChanged: true,
        downloadError: "",
        downloadErrorStage: "",
        downloadBulkResult: null
      });
    }
    const store = {
      async acquirePreview(src, signal, options2) {
        if (disposed) throw new DOMException("Preview request aborted", "AbortError");
        if (!state.status?.features?.includes("read")) throw new Error("Preview unavailable");
        return previews.acquire(src, signal, options2);
      },
      invalidatePreview(src, url) {
        previews.invalidate(src, url);
      },
      previewCacheStats() {
        return previews.stats();
      },
      getSnapshot: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      reload,
      set,
      dismissDownloadNotice(id) {
        if (state.downloadNotice?.id === id) publish({ downloadNotice: null });
      },
      async cancelDownload(taskId) {
        if (disposed || state.busy) return false;
        const sequence = actionSequence + 1;
        publish({ downloadCancellingId: taskId });
        const cancelled = await store.invoke("cancel", { taskId });
        if (disposed || sequence !== actionSequence) return false;
        publish({ downloadCancellingId: "", ...cancelled ? {} : { downloadNotice: { id: `cancel:${taskId}:${sequence}`, kind: "cancelFailed" } } });
        return cancelled;
      },
      planFingerprint() {
        return JSON.stringify([state.runId, [...state.selected].sort(), state.operation]);
      },
      selectTab(tab) {
        if (["search", "collections", "tasks", "changes", "account"].includes(tab)) set({ tab, ...tab === "account" ? { accountVisited: true } : {} });
      },
      selectPhoto(photo, sourceCollectionId) {
        if (!photo?.id) return;
        cancelCollectionSelection();
        const selectedPhotos = { ...state.selectedPhotos, [photo.id]: photo }, photoSources = { ...state.photoSources };
        if (sourceCollectionId) photoSources[photo.id] = [.../* @__PURE__ */ new Set([...photoSources[photo.id] ?? [], sourceCollectionId])];
        set({ selectedPhotos, photoSources });
      },
      togglePhoto(photo, sourceCollectionId) {
        if (!photo?.id) return;
        cancelCollectionSelection();
        const selectedPhotos = { ...state.selectedPhotos }, photoSources = { ...state.photoSources };
        if (selectedPhotos[photo.id]) {
          delete selectedPhotos[photo.id];
          delete photoSources[photo.id];
        } else {
          selectedPhotos[photo.id] = photo;
          if (sourceCollectionId) photoSources[photo.id] = [.../* @__PURE__ */ new Set([...photoSources[photo.id] ?? [], sourceCollectionId])];
        }
        set({ selectedPhotos, photoSources });
      },
      removePhoto(id) {
        cancelCollectionSelection();
        const selectedPhotos = { ...state.selectedPhotos }, photoSources = { ...state.photoSources };
        delete selectedPhotos[id];
        delete photoSources[id];
        set({ selectedPhotos, photoSources });
      },
      clearSelection() {
        cancelCollectionSelection();
        set({ selectedPhotos: {}, photoSources: {} });
      },
      isCollectionFullySelected() {
        const page = state.regions.collection.data;
        const ids = state.collectionSelectionIds.length ? state.collectionSelectionIds : page && !page.hasMore ? page.items.map((photo) => photo.id) : [];
        return ids.length > 0 && ids.every((id) => state.selectedPhotos[id] && state.photoSources[id]?.includes(state.collectionId));
      },
      async toggleCollectionSelection() {
        if (state.collectionSelecting) {
          cancelCollectionSelection();
          return false;
        }
        const id = state.collectionId;
        if (disposed || !id || !state.status?.features?.includes("read") || state.busy || state.collectionAction) return false;
        if (store.isCollectionFullySelected()) {
          const ids = state.collectionSelectionIds.length ? state.collectionSelectionIds : state.regions.collection.data.items.map((photo) => photo.id);
          const selectedPhotos = { ...state.selectedPhotos }, photoSources = { ...state.photoSources };
          for (const photoId of ids) {
            const remaining = (photoSources[photoId] ?? []).filter((source) => source !== id);
            if (remaining.length) photoSources[photoId] = remaining;
            else {
              delete selectedPhotos[photoId];
              delete photoSources[photoId];
            }
          }
          publish({ selectedPhotos, photoSources, collectionSelectionError: "" });
          return true;
        }
        const controller = new AbortController(), sequence = ++collectionSelectionSequence;
        controllers.set("collection-selection", controller);
        publish({ collectionSelecting: true, collectionSelectionError: "" });
        const current = () => !disposed && !controller.signal.aborted && sequence === collectionSelectionSequence && state.collectionId === id;
        const photos = /* @__PURE__ */ new Map();
        let offset = 0;
        try {
          while (current()) {
            const page = await callData("collection-items", { collectionId: id, offset }, controller.signal);
            if (!current()) return false;
            if (!Array.isArray(page.items) || page.offset !== offset || !Number.isSafeInteger(page.total) || page.total < 0 || typeof page.hasMore !== "boolean") throw new Error("collection-selection-incomplete");
            for (const photo of page.items) {
              if (!photo || typeof photo.id !== "string" || !photo.id) throw new Error("collection-selection-incomplete");
              photos.set(photo.id, photo);
            }
            if (!page.hasMore) {
              if (photos.size !== page.total) throw new Error("collection-selection-incomplete");
              break;
            }
            if (!page.items.length) throw new Error("collection-selection-incomplete");
            offset += page.items.length;
          }
          if (!current()) return false;
          const selectedPhotos = { ...state.selectedPhotos }, photoSources = { ...state.photoSources };
          for (const [photoId, photo] of photos) {
            selectedPhotos[photoId] = photo;
            photoSources[photoId] = [.../* @__PURE__ */ new Set([...photoSources[photoId] ?? [], id])];
          }
          publish({ selectedPhotos, photoSources, collectionSelectionIds: [...photos.keys()] });
          return true;
        } catch (error) {
          if (current()) publish({ collectionSelectionError: "collection-selection-failed" });
          return false;
        } finally {
          if (controllers.get("collection-selection") === controller) controllers.delete("collection-selection");
          if (current()) publish({ collectionSelecting: false });
        }
      },
      async loadDownloadOptions({ reset = false } = {}) {
        const photoIds = Object.keys(state.selectedPhotos);
        if (!photoIds.length) return false;
        downloadController?.abort();
        const controller = new AbortController(), sequence = ++downloadSequence;
        downloadController = controller;
        publish({
          downloadOptionsLoading: true,
          downloadError: "",
          downloadErrorStage: "",
          downloadQuoteChanged: false,
          downloadPlan: null,
          downloadBulkResult: null,
          ...reset ? { downloadOptions: null, downloadSelected: {}, downloadDirectory: null } : {}
        });
        try {
          const options2 = await callData("download-options", { photoIds }, controller.signal);
          if (!currentDownload(sequence)) return false;
          const selected = chooseDownloadRenditions(options2.photos ?? [], { kind: "free" }, false);
          publish({ downloadOptions: options2, downloadSelected: selected });
          return true;
        } catch (error) {
          if (currentDownload(sequence)) publish({ downloadError: error.message, downloadErrorStage: "options" });
          return false;
        } finally {
          if (currentDownload(sequence)) {
            downloadController = null;
            publish({ downloadOptionsLoading: false });
          }
        }
      },
      setDownloadRendition(photoId, renditionId) {
        const downloadSelected = { ...state.downloadSelected };
        if (renditionId) downloadSelected[photoId] = renditionId;
        else delete downloadSelected[photoId];
        publish({ downloadSelected, downloadPlan: null, downloadQuoteChanged: false, downloadBulkResult: null });
      },
      applyDownloadQuality(preference) {
        if (disposed || state.downloadBusy || state.downloadOptionsLoading || !state.downloadOptions || state.downloadErrorStage === "options") return false;
        const photos = state.downloadOptions.photos.filter((photo) => Object.hasOwn(state.selectedPhotos, photo.id));
        const selected = chooseDownloadRenditions(photos, preference, state.status?.features?.includes("write"));
        const matched = Object.keys(selected).length;
        if (!matched) return false;
        publish({
          downloadSelected: { ...state.downloadSelected, ...selected },
          downloadPlan: null,
          downloadQuoteChanged: false,
          downloadBulkResult: { matched, total: Object.keys(state.selectedPhotos).length }
        });
        return true;
      },
      async pickDownloadDirectory() {
        if (state.downloadBusy) return false;
        const sequence = downloadSequence;
        publish({ downloadBusy: true, downloadBusyStage: "directory", ...state.downloadErrorStage !== "options" ? { downloadError: "", downloadErrorStage: "" } : {} });
        try {
          const directory = await call("pick-download-directory");
          if (!currentDownload(sequence)) return false;
          if (directory) publish({ downloadDirectory: directory, downloadPlan: null });
          return Boolean(directory);
        } catch (error) {
          if (currentDownload(sequence)) publish({ downloadError: error.message, downloadErrorStage: "directory" });
          return false;
        } finally {
          if (currentDownload(sequence)) publish({ downloadBusy: false, downloadBusyStage: "" });
        }
      },
      async prepareDownload({ prefix = "", suffix = "" } = {}) {
        if (!state.downloadDirectory || state.downloadBusy || state.downloadOptionsLoading || state.downloadErrorStage === "options") return false;
        const items = Object.entries(state.downloadSelected).map(([photoId, renditionId]) => ({ photoId, renditionId }));
        if (!items.length) return false;
        const sequence = downloadSequence;
        publish({ downloadBusy: true, downloadBusyStage: "prepare", downloadError: "", downloadErrorStage: "", downloadPlan: null });
        try {
          const plan = await call("download-prepare", { items, directoryId: state.downloadDirectory.directoryId, prefix, suffix });
          if (!currentDownload(sequence)) return false;
          if (plan.changed) {
            changedDownloadQuote(plan);
            return false;
          }
          publish({ downloadPlan: plan, downloadQuoteChanged: false });
          return true;
        } catch (error) {
          if (currentDownload(sequence)) publish({
            downloadError: error.message,
            downloadErrorStage: "prepare",
            ...error.message === "download-directory-expired" ? { downloadDirectory: null } : {}
          });
          return false;
        } finally {
          if (currentDownload(sequence)) publish({ downloadBusy: false, downloadBusyStage: "" });
        }
      },
      async confirmDownload() {
        const plan = state.downloadPlan;
        if (!plan?.planId || !plan.confirmation || state.downloadBusy) return false;
        const sequence = downloadSequence;
        publish({ downloadBusy: true, downloadBusyStage: "confirm", downloadError: "", downloadErrorStage: "" });
        try {
          const result = await call("download-confirm", { planId: plan.planId, confirmation: plan.confirmation, confirmed: true });
          if (!currentDownload(sequence)) return false;
          if (result.requiresReconfirmation) {
            changedDownloadQuote(result);
            return false;
          }
          set({
            downloadResult: { ...result, total: plan.items.length },
            collectionAction: null,
            downloadPlan: null,
            downloadQuoteChanged: false,
            downloadNotice: { id: result.downloadId, kind: "started", total: plan.items.length }
          });
          await reload();
          return true;
        } catch (error) {
          if (currentDownload(sequence)) publish({ downloadError: error.message, downloadErrorStage: "confirm", downloadPlan: null });
          return false;
        } finally {
          if (currentDownload(sequence)) publish({ downloadBusy: false, downloadBusyStage: "" });
        }
      },
      openAddFavorites() {
        const photos = Object.values(state.selectedPhotos);
        if (!photos.length || photos.length > 120 || state.busy || state.favoritesRequest || state.collectionSelecting || !state.status?.features?.includes("write") || !state.status?.features?.includes("read")) return false;
        const request = {
          photos: photos.map((photo) => ({ ...photo })),
          photoSources: Object.fromEntries(photos.map((photo) => [photo.id, [...state.photoSources[photo.id] ?? []]]))
        };
        publish({ favoritesRequest: request, favoritesError: "", favoritesResult: null });
        void store.loadCollections();
        return true;
      },
      closeAddFavorites() {
        if (state.favoritesBusy) return;
        publish({ favoritesRequest: null, favoritesError: "", favoritesResult: null });
      },
      async addFavorites(targetCollectionId) {
        const request = state.favoritesRequest, target = state.regions.collections.data?.items?.find((item) => item.id === targetCollectionId);
        if (!request || state.busy || state.favoritesBusy || state.favoritesResult || !target || target.readOnly || !target.name?.trim() || state.regions.collections.loading || state.regions.collections.error || !state.status?.features?.includes("write") || !state.status?.features?.includes("read") || !request.photos.length || request.photos.length > 120) return false;
        const sequence = ++actionSequence;
        const current = () => !disposed && actionSequence === sequence && state.favoritesRequest === request;
        publish({ busy: true, favoritesBusy: true, favoritesError: "", favoritesResult: null });
        try {
          const result = await call("collection-operation", {
            action: "copy",
            photoIds: request.photos.map((photo) => photo.id),
            photoSources: request.photoSources,
            targetCollectionId
          });
          if (!current()) return false;
          const photoSources = { ...state.photoSources };
          for (const row of result.items ?? []) if (row.status === "completed" && state.selectedPhotos[row.photoId]) {
            photoSources[row.photoId] = [.../* @__PURE__ */ new Set([...photoSources[row.photoId] ?? [], targetCollectionId])];
          }
          publish({ favoritesResult: result, photoSources });
          await Promise.all([store.loadCollections(), state.collectionId ? store.openCollection(state.collectionId) : Promise.resolve()]);
          return true;
        } catch (error) {
          if (current()) publish({ favoritesError: error.message });
          return false;
        } finally {
          if (current()) publish({ busy: false, favoritesBusy: false });
        }
      },
      async submitCollectionOperation(action, targetCollectionId) {
        const photoIds = Object.keys(state.selectedPhotos);
        if (!photoIds.length || state.busy || disposed) return false;
        const sequence = ++actionSequence;
        const current = () => !disposed && actionSequence === sequence;
        publish({ busy: true, downloadError: "", collectionActionResult: null });
        try {
          const result = await call("collection-operation", {
            action,
            photoIds,
            photoSources: Object.fromEntries(photoIds.map((id) => [id, state.photoSources[id] ?? []])),
            ...targetCollectionId ? { targetCollectionId } : {}
          });
          if (!current()) return false;
          const photoSources = { ...state.photoSources };
          for (const row of result.items ?? []) if (row.status === "completed" || row.status === "partial") {
            photoSources[row.photoId] = row.sourceCollectionIds ?? [];
          }
          publish({ collectionActionResult: result, photoSources });
          await Promise.all([store.loadCollections(), state.collectionId ? store.openCollection(state.collectionId) : Promise.resolve()]);
          return true;
        } catch (error) {
          if (current()) publish({ downloadError: error.message });
          return false;
        } finally {
          if (current()) publish({ busy: false });
        }
      },
      closePhoto() {
        controllers.get("detail")?.abort();
        controllers.delete("detail");
        sequences.detail++;
        publish({ detail: null, regions: { ...state.regions, detail: emptyRegion() } });
      },
      async credentialReferenceUpdated(ref) {
        const references = state.account?.references;
        if (!references || [references.accessTokenRef, references.usernameRef, references.passwordRef].includes(ref)) {
          store.resetData();
          await Promise.all([store.reload(), store.loadAccount()]);
        } else if (ref === references.visionKeyRef) await store.loadAccount();
      },
      async resetAndReload() {
        store.resetData();
        await Promise.all([store.reload(), store.loadAccount()]);
      },
      async loadAccount() {
        const { sequence, controller } = startRegion("account");
        try {
          const account = await callData("account-summary", {}, controller.signal);
          if (!finishRegion("account", sequence, account)) return false;
          publish({ account, targetPerCategory: account.settings?.targetPerCategory ?? null, threshold: account.settings?.threshold ?? null });
          return true;
        } catch (error) {
          return failRegion("account", sequence, error);
        } finally {
          if (controllers.get("account") === controller) controllers.delete("account");
        }
      },
      async searchPhotos({ more = false } = {}) {
        const query = more ? state.submittedQuery : state.queryDraft.trim();
        if (!query) return false;
        const prior = state.regions.search.data;
        if (more && (!prior?.hasMore || !prior.cursor || state.regions.search.loading)) return false;
        const language = more ? state.submittedLanguage : state.language;
        const { sequence, controller } = startRegion("search", { clearData: !more, loadMode: more ? "more" : "initial" });
        if (!more) {
          searchCursors.clear();
          publish({ submittedQuery: query, submittedLanguage: language });
        }
        const args = { query, ...language ? { language } : {}, ...more ? { cursor: prior.cursor } : {} };
        try {
          const page = await callData("photo-search", args, controller.signal);
          if (disposed || sequences.search !== sequence || state.submittedQuery !== query || state.submittedLanguage !== language) return false;
          if (!Array.isArray(page.items) || typeof page.hasMore !== "boolean") throw new Error("Invalid AFP search page");
          const items = dedupeItems(more ? prior.items : [], page.items);
          const validCursor = typeof page.cursor === "string" && page.cursor.trim().length > 0 && page.cursor.length <= 8192;
          const stalled = page.hasMore && (!validCursor || !page.items.length || more && (items.length === prior.items.length || searchCursors.has(page.cursor)));
          const hasMore = page.hasMore && !stalled;
          if (hasMore) searchCursors.add(page.cursor);
          const data = { ...page, items, hasMore, cursor: hasMore ? page.cursor : null, ...stalled ? { paginationStopped: true } : {} };
          return finishRegion("search", sequence, data);
        } catch (error) {
          return failRegion("search", sequence, error);
        } finally {
          if (controllers.get("search") === controller) controllers.delete("search");
        }
      },
      async loadProfile() {
        return readRegion("profile", "account-profile", {});
      },
      async loadCollections() {
        return readRegion("collections", "collection-list", {});
      },
      async openCollection(id) {
        if (!id) return false;
        cancelCollectionSelection();
        store.closePhoto();
        const { sequence, controller } = startRegion("collection", { clearData: true, loadMode: "initial" });
        publish({ collectionId: id, collectionNextOffset: 0, collectionSelectionIds: [] });
        try {
          const page = await callData("collection-items", { collectionId: id }, controller.signal);
          if (disposed || sequences.collection !== sequence || state.collectionId !== id) return false;
          publish({ collectionNextOffset: page.offset + page.items.length });
          return finishRegion("collection", sequence, page);
        } catch (error) {
          return failRegion("collection", sequence, error);
        } finally {
          if (controllers.get("collection") === controller) controllers.delete("collection");
        }
      },
      async loadMoreCollection() {
        const prior = state.regions.collection.data, id = state.collectionId;
        if (!prior?.hasMore || !id || state.regions.collection.loading) return false;
        const { sequence, controller } = startRegion("collection", { loadMode: "more" });
        try {
          const offset = state.collectionNextOffset ?? prior.offset + prior.items.length;
          const page = await callData("collection-items", { collectionId: id, offset }, controller.signal);
          if (disposed || sequences.collection !== sequence || state.collectionId !== id) return false;
          if (!Array.isArray(page.items) || page.offset !== offset || typeof page.hasMore !== "boolean") throw new Error("Invalid AFP collection page");
          const items = dedupeItems(prior.items, page.items);
          const stalled = page.hasMore && (!page.items.length || items.length === prior.items.length);
          publish({ collectionNextOffset: page.offset + page.items.length });
          return finishRegion("collection", sequence, { ...page, items, hasMore: page.hasMore && !stalled, ...stalled ? { paginationStopped: true } : {} });
        } catch (error) {
          return failRegion("collection", sequence, error);
        } finally {
          if (controllers.get("collection") === controller) controllers.delete("collection");
        }
      },
      async loadHistory(kind, { more = false } = {}) {
        if (!["runs", "plans"].includes(kind)) return false;
        const name = kind;
        const prior = state.regions[name].data;
        if (more && (!prior?.hasMore || state.regions[name].loading)) return false;
        const { sequence, controller } = startRegion(name, { clearData: !more });
        const args = { kind, ...more ? pageArgs(prior) : {} };
        try {
          const page = await callData("history-list", args, controller.signal);
          if (disposed || sequences[name] !== sequence) return false;
          return finishRegion(name, sequence, more ? { ...page, items: [...prior.items, ...page.items] } : page);
        } catch (error) {
          return failRegion(name, sequence, error);
        } finally {
          if (controllers.get(name) === controller) controllers.delete(name);
        }
      },
      refreshCompletedTaskData() {
        if (state.regions.runs.data && !state.regions.runs.loading) void store.loadHistory("runs");
        if (state.regions.plans.data && !state.regions.plans.loading) void store.loadHistory("plans");
        if (state.runId && state.regions.run.data && !state.regions.run.loading) {
          void store.openRun(state.runId, { category: state.reportCategory, decision: state.reportFilter });
        }
      },
      async openRun(id, { category = "", decision = "all", more = false } = {}) {
        if (!id) return false;
        const key = `${id}:${category}:${decision}`;
        const prior = state.regions.run.data;
        if (more && (!prior?.hasMore || state.regions.run.loading)) return false;
        const { sequence, controller } = startRegion("run", { clearData: !more });
        publish({
          runId: id,
          reportCategory: category,
          reportFilter: decision,
          ...more ? {} : { plan: null, planFingerprint: "", confirmChecked: false }
        });
        if (more) publish({ regions: { ...state.regions, run: { ...state.regions.run, loading: true, error: "" } } });
        const args = { runId: id, decision, ...category ? { category } : {}, ...more ? { offset: prior?.items?.length ?? 0 } : {} };
        try {
          const page = await callData("run-items", args, controller.signal);
          if (disposed || sequences.run !== sequence || state.runId !== id || state.reportCategory !== category || state.reportFilter !== decision) return false;
          return finishRegion("run", sequence, more ? { ...page, items: [...prior.items, ...page.items] } : page);
        } catch (error) {
          return failRegion("run", sequence, error);
        } finally {
          if (controllers.get("run") === controller) controllers.delete("run");
        }
      },
      async openPhoto(photo) {
        if (!photo?.id) return false;
        publish({ detail: photo });
        const { sequence, controller } = startRegion("detail");
        try {
          const detail = await callData("photo-details", { photoId: photo.id }, controller.signal);
          if (disposed || sequences.detail !== sequence || state.detail?.id !== photo.id) return false;
          const merged = detail ? { ...state.detail, ...detail } : state.detail;
          if (merged) publish({ detail: merged });
          return finishRegion("detail", sequence, merged ?? photo);
        } catch (error) {
          return failRegion("detail", sequence, error);
        } finally {
          if (controllers.get("detail") === controller) controllers.delete("detail");
        }
      },
      async previewPlan() {
        const fingerprint = store.planFingerprint();
        if (state.busy || !state.status?.features?.includes("write") || !state.selected.length || state.operation !== "clear" && !state.runId.trim()) return false;
        const args = {
          operation: state.operation,
          categories: state.selected,
          ...state.operation === "clear" ? {} : { runId: state.runId.trim() }
        };
        publish({ busy: true, plan: null, planFingerprint: "", confirmChecked: false, error: "" });
        const sequence = ++actionSequence;
        try {
          const plan = await call("plan", args);
          if (disposed || sequence !== actionSequence || store.planFingerprint() !== fingerprint) return false;
          publish({ plan, planFingerprint: fingerprint, confirmChecked: false });
          return true;
        } catch (error) {
          if (!disposed && sequence === actionSequence) publish({ error: error.message });
          return false;
        } finally {
          if (!disposed && sequence === actionSequence) publish({ busy: false });
        }
      },
      async confirmPlan() {
        const plan = state.plan, fingerprint = store.planFingerprint();
        if (state.busy || !plan || !state.status?.features?.includes("write") || !state.confirmChecked || state.planFingerprint !== fingerprint || !Number.isFinite(plan.expiresAt) || plan.expiresAt <= Date.now()) return false;
        publish({ busy: true, plan: null, planFingerprint: "", confirmChecked: false, error: "" });
        const sequence = ++actionSequence;
        try {
          const result = await call("confirm", { planId: plan.planId, confirmation: plan.confirmation, confirmed: true });
          if (disposed || sequence !== actionSequence) return false;
          publish({ result, toast: "writeSubmitted" });
          await reload();
          void store.loadHistory("plans");
          return true;
        } catch (error) {
          if (!disposed && sequence === actionSequence) publish({ error: error.message });
          return false;
        } finally {
          if (!disposed && sequence === actionSequence) publish({ busy: false });
        }
      },
      async invoke(operation, args = {}) {
        if (state.busy) return false;
        const sequence = ++actionSequence;
        publish({ busy: true, error: "" });
        try {
          const result = operation === "status" ? (await reload(), state.status) : await call(operation, args);
          if (disposed || sequence !== actionSequence) return false;
          if (operation !== "status") publish({ result, ...operation === "refresh" ? { toast: "refreshSubmitted" } : {} });
          if (result.runId) set({ runId: result.runId });
          if (operation !== "status") await reload();
          return true;
        } catch (error) {
          if (!disposed && sequence === actionSequence) publish({ error: error.message });
          return false;
        } finally {
          if (!disposed && sequence === actionSequence) publish({ busy: false });
        }
      },
      async toggle(id, enabled) {
        if (state.saving.includes(id)) return featureQueue;
        publish({ saving: [...state.saving, id], pendingTargets: { ...state.pendingTargets, [id]: enabled }, error: "" });
        featureQueue = featureQueue.then(async () => {
          const bundles = await ctx.remote.pluginManager.listBundles();
          if (!bundles.ok) throw new Error(bundles.error.message);
          const features = bundles.value.find((bundle) => bundle.name === NAME)?.features ?? [];
          const ids = features.filter((feature) => feature.id === id ? enabled : feature.enabled).map((feature) => feature.id);
          const result = await ctx.remote.pluginManager.setBundleFeatures(NAME, ids, false);
          if (!result.ok) throw new Error(result.error.message);
          if (result.value.application === "failed") throw new Error(result.value.error?.diagnostic ?? "AFP configuration save failed");
          await reload();
        }).catch(async (error) => {
          await reload();
          publish({ error: error.message });
        }).finally(() => {
          const pendingTargets = { ...state.pendingTargets };
          delete pendingTargets[id];
          publish({ saving: state.saving.filter((key) => key !== id), pendingTargets });
        });
        return featureQueue;
      },
      resetData() {
        searchCursors.clear();
        cancelCollectionSelection();
        previews.configure(null);
        previews.clear();
        downloadSequence++;
        downloadController?.abort();
        downloadController = null;
        for (const controller of controllers.values()) controller.abort();
        controllers.clear();
        for (const name of regionNames) sequences[name]++;
        reloadSequence++;
        poll = null;
        actionSequence++;
        publish({
          previewGeneration: state.previewGeneration + 1,
          account: null,
          status: null,
          features: [],
          queryDraft: "",
          submittedQuery: "",
          language: "",
          submittedLanguage: "",
          regions: Object.fromEntries(regionNames.map((name) => [name, emptyRegion()])),
          collectionId: "",
          collectionNextOffset: 0,
          collectionFilter: "",
          selectedPhotos: {},
          photoSources: {},
          selectionOpen: false,
          detail: null,
          runId: "",
          selected: ["food"],
          operation: "append",
          reportCategory: "",
          collectionSelecting: false,
          collectionSelectionError: "",
          collectionSelectionIds: [],
          favoritesRequest: null,
          favoritesBusy: false,
          favoritesError: "",
          favoritesResult: null,
          collectionAction: null,
          collectionActionResult: null,
          downloadOptions: null,
          downloadSelected: {},
          downloadOptionsLoading: false,
          downloadBulkResult: null,
          downloadDirectory: null,
          downloadPlan: null,
          downloadBusy: false,
          downloadBusyStage: "",
          downloadError: "",
          downloadErrorStage: "",
          downloadQuoteChanged: false,
          downloadResult: null,
          downloadDockOpen: false,
          downloadNotice: null,
          downloadCancellingId: "",
          reportFilter: "all",
          targetPerCategory: null,
          threshold: null,
          plan: null,
          planFingerprint: "",
          confirmChecked: false,
          result: null,
          busy: false,
          toast: "",
          error: ""
        });
      },
      dispose() {
        disposed = true;
        listeners.clear();
        actionSequence++;
        downloadSequence++;
        downloadController?.abort();
        for (const name of regionNames) sequences[name]++;
        for (const controller of controllers.values()) controller.abort();
        controllers.clear();
        return previews.dispose();
      }
    };
    return store;
  }

  // src/client/afp-configuration-form.js
  function createConfigurationForm(React, { Input, Button, StateDot, Tag, Toast, Tooltip, Chevron }, ctx, t) {
    const h = React.createElement;
    return function ConfigurationForm({ view, featureId, onSaved, className = "", section, sectionId }) {
      const [loaded, setLoaded] = React.useState(null), [text, setText] = React.useState(""), [secrets, setSecrets] = React.useState({});
      const [message, setMessage] = React.useState(""), [busy, setBusy] = React.useState(false), [acquiringToken, setAcquiringToken] = React.useState(false);
      const [draft, setDraft] = React.useState({});
      const [savedToast, setSavedToast] = React.useState("");
      const [visibleCredentials, setVisibleCredentials] = React.useState({});
      const [advancedOpen, setAdvancedOpen] = React.useState(true);
      const [revealedCredentials, setRevealedCredentials] = React.useState({}), [readingCredentials, setReadingCredentials] = React.useState({});
      const credentialReads = React.useRef({ active: true, requests: {} });
      const formId = React.useId();
      function clearCredentialViews() {
        credentialReads.current.requests = {};
        setRevealedCredentials({});
        setReadingCredentials({});
        setVisibleCredentials({});
      }
      async function read(preserveDraft = false, alive = () => true) {
        const result = await ctx.remote.pluginManager.invokeAction("dsh-plugin-afp", "configuration", { operation: "read" });
        if (!result.ok) throw new Error();
        const value = JSON.parse(result.value.output);
        if (!alive()) return;
        clearCredentialViews();
        setLoaded(value);
        if (!preserveDraft) {
          setDraft(value.config);
          setText(JSON.stringify(value.config, null, 2));
          setSecrets((current) => {
            const { usernameRef, ...rest } = current;
            return rest;
          });
        }
      }
      React.useEffect(() => {
        if (view !== "page") return;
        credentialReads.current.active = true;
        let mounted = true;
        void read(false, () => mounted).catch(() => {
          if (mounted) setMessage(t("configUnavailable"));
        });
        return () => {
          mounted = false;
          credentialReads.current.active = false;
          credentialReads.current.requests = {};
        };
      }, [view]);
      React.useEffect(() => {
        clearCredentialViews();
      }, [section]);
      if (view !== "page") return t("configHelp");
      const info = (key) => loaded?.credentials?.[key];
      const hasCredential = (key) => Boolean((key === "usernameRef" ? String(secrets[key] ?? "").trim() : secrets[key]) || info(key)?.configured);
      async function saveSecrets(keys) {
        for (const key of keys) {
          const value = key === "usernameRef" ? String(secrets[key] ?? "").trim() : secrets[key];
          if (!value) continue;
          const result = await ctx.remote.credentials.set(loaded.config[key], value);
          if (!result.ok) throw new Error();
          setSecrets((current) => {
            const next = { ...current, [key]: "" };
            if (key === "usernameRef") delete next[key];
            return next;
          });
          setVisibleCredentials((current) => ({ ...current, [key]: false }));
        }
      }
      async function acquireToken() {
        if (!hasCredential("usernameRef") || !hasCredential("passwordRef")) {
          setMessage(t("tokenCredentialsRequired"));
          return;
        }
        clearCredentialViews();
        setBusy(true);
        setAcquiringToken(true);
        setMessage("");
        try {
          await saveSecrets(["usernameRef", "passwordRef"]);
          const result = await ctx.remote.pluginManager.invokeAction("dsh-plugin-afp", "configuration", { operation: "acquire-token" });
          if (!result.ok) throw new Error();
          await read(true);
          setSavedToast(t("tokenAcquired"));
          onSaved?.();
        } catch (error2) {
          setMessage(t("tokenAcquireFailed"));
        } finally {
          setBusy(false);
          setAcquiringToken(false);
        }
      }
      async function save() {
        clearCredentialViews();
        setBusy(true);
        setMessage("");
        try {
          const next = JSON.parse(text);
          if (JSON.stringify(next) !== JSON.stringify(loaded.config) && ["accessTokenRef", "usernameRef", "passwordRef", "visionKeyRef"].some((key) => next[key] !== loaded.config[key] && secrets[key])) {
            setMessage(t("referenceChangeRequired"));
            return;
          }
          await saveSecrets(["accessTokenRef", "usernameRef", "passwordRef", "visionKeyRef"]);
          if (JSON.stringify(next) !== JSON.stringify(loaded.config)) {
            const result = await ctx.remote.pluginManager.invokeAction("dsh-plugin-afp", "configuration", { operation: "save", config: text, revision: loaded.revision });
            if (!result.ok) throw new Error();
          }
          await read();
          setSavedToast(t("configSaved"));
          onSaved?.();
        } catch (error2) {
          setMessage(t("configFailed"));
        } finally {
          setBusy(false);
        }
      }
      const showVision = featureId === void 0 || featureId === "refresh";
      async function revealCredential(key) {
        const request = {};
        credentialReads.current.requests[key] = request;
        const current = () => credentialReads.current.active && credentialReads.current.requests[key] === request;
        setReadingCredentials((value) => ({ ...value, [key]: true }));
        setMessage("");
        try {
          const result = await ctx.remote.pluginManager.invokeAction("dsh-plugin-afp", "configuration", { operation: "reveal-credential", key, revision: loaded.revision });
          if (!current()) return;
          if (!result.ok) throw new Error();
          const payload = JSON.parse(result.value.output);
          if (typeof payload.value !== "string" || !payload.value) throw new Error();
          setRevealedCredentials((value) => ({ ...value, [key]: payload.value }));
          setVisibleCredentials((value) => ({ ...value, [key]: true }));
        } catch (error2) {
          if (current()) setMessage(t("credentialRevealFailed"));
        } finally {
          if (current()) {
            delete credentialReads.current.requests[key];
            setReadingCredentials((value) => ({ ...value, [key]: false }));
          }
        }
      }
      const credentialField = (key) => {
        const username = key === "usernameRef", visible = Boolean(visibleCredentials[key]), inputId = `${formId}-${key}`;
        const visibilityLabel = `${t(visible ? "hideCredential" : "showCredential")} ${t(key)}`;
        const eye = h(
          "svg",
          {
            width: 16,
            height: 16,
            viewBox: "0 0 16 16",
            fill: "none",
            stroke: "currentColor",
            strokeWidth: 1,
            strokeLinecap: "round",
            strokeLinejoin: "round",
            "aria-hidden": true
          },
          h("path", { d: "M1.5 8s2.25-4 6.5-4 6.5 4 6.5 4-2.25 4-6.5 4S1.5 8 1.5 8Z" }),
          h("circle", { cx: 8, cy: 8, r: 1.75 }),
          !visible ? h("path", { d: "m2 2 12 12" }) : null
        );
        const toggle = username ? null : h(Button, {
          variant: "ghost",
          size: "sm",
          type: "button",
          className: "afp-credential-visibility",
          icon: readingCredentials[key] && StateDot ? h(StateDot, { state: "ongoing", size: 14 }) : eye,
          "aria-label": visibilityLabel,
          "aria-controls": inputId,
          "aria-pressed": visible,
          "aria-busy": Boolean(readingCredentials[key]),
          disabled: busy || Boolean(readingCredentials[key]) || !secrets[key] && !info(key)?.configured,
          onMouseDown: (event) => event.preventDefault(),
          onClick: (event) => {
            if (!visible && !secrets[key]) {
              void revealCredential(key);
              return;
            }
            const input = event.currentTarget.closest(".afp-secret-control")?.querySelector("input");
            const focused = input && input.ownerDocument.activeElement === input;
            const start = input?.selectionStart, end = input?.selectionEnd, direction = input?.selectionDirection;
            setVisibleCredentials((current) => ({ ...current, [key]: !current[key] }));
            if (visible) setRevealedCredentials((current) => {
              const next = { ...current };
              delete next[key];
              return next;
            });
            if (focused) queueMicrotask(() => {
              if (input.isConnected) input.setSelectionRange(start, end, direction);
            });
          }
        });
        return h(
          "div",
          { key, className: "afp-form-field" },
          h(
            "div",
            { className: "afp-form-label" },
            h("label", { htmlFor: inputId }, t(key)),
            h(Tag, { tone: info(key)?.configured ? "success" : "quiet" }, t(info(key)?.configured ? "configured" : "missing"))
          ),
          h(
            "div",
            { className: username ? void 0 : "afp-secret-control" },
            h(Input, {
              className: `afp-wb-input${!username && info(key)?.configured && !secrets[key] && !visible ? " afp-stored-mask" : ""}`,
              id: inputId,
              type: username || visible ? "text" : "password",
              autoComplete: username ? "username" : "new-password",
              spellCheck: false,
              value: username ? secrets[key] ?? loaded.username ?? "" : secrets[key] || revealedCredentials[key] || "",
              disabled: busy || info(key)?.writable === false,
              "aria-label": t(key),
              placeholder: t(!username && info(key)?.configured ? "maskedCredential" : "enterCredential"),
              onChange: (event) => {
                const value = event.target.value;
                delete credentialReads.current.requests[key];
                setReadingCredentials((current) => ({ ...current, [key]: false }));
                setRevealedCredentials((current) => {
                  const next = { ...current };
                  delete next[key];
                  return next;
                });
                setSecrets((current) => ({ ...current, [key]: value }));
                if (!value) setVisibleCredentials((current) => ({ ...current, [key]: false }));
              }
            }),
            toggle && Tooltip ? h(Tooltip, { label: visibilityLabel, side: "top", portal: true }, toggle) : toggle
          )
        );
      };
      const field = (key) => h(
        "label",
        { key, className: "afp-form-field" },
        t(key),
        h(Input, {
          className: "afp-wb-input",
          value: ["string", "number"].includes(typeof draft[key]) ? draft[key] : "",
          type: typeof loaded.config[key] === "number" ? "number" : "text",
          step: key === "threshold" ? 0.01 : 1,
          disabled: busy,
          "aria-label": t(key),
          onChange: (event) => {
            const next = { ...draft, [key]: typeof loaded.config[key] === "number" ? Number(event.target.value) : event.target.value };
            setDraft(next);
            setText(JSON.stringify(next, null, 2));
          }
        })
      );
      const token = loaded?.token;
      const tokenExpired = token?.expiresAt != null && token.expiresAt <= Date.now();
      const loading = !loaded && !message;
      const visionFields = ["visionBaseUrl", "visionKeyRef", "visionModel"];
      const budgetFields = ["targetPerCategory", "batchSize", "maxBatches", "concurrency", "threshold"];
      const panelProps = (value) => sectionId ? { role: "tabpanel", id: `${sectionId}-${value}-panel`, "aria-labelledby": `${sectionId}-${value}`, hidden: section !== value } : {};
      const skeletonField = (key) => h(
        "div",
        { key, className: "afp-form-field", "aria-hidden": true },
        h("span", { className: "afp-skeleton afp-skeleton-label" }),
        h("span", { className: "afp-skeleton afp-skeleton-input" })
      );
      const columns = loaded || loading ? h(
        "div",
        { className: "afp-config-columns", ...loading ? { role: "status", "aria-label": t("loading") } : {} },
        h(
          "section",
          { className: "afp-config-section", ...panelProps("credentials") },
          h("h4", { className: "afp-form-heading" }, t("accountConfiguration")),
          h("div", { className: "afp-credential-grid" }, ...["usernameRef", "passwordRef", "accessTokenRef"].map(loading ? skeletonField : credentialField)),
          loading ? h(
            "div",
            { className: "afp-token-line", "aria-hidden": true },
            h("span", { className: "afp-skeleton afp-skeleton-label" }),
            h("span", { className: "afp-skeleton afp-skeleton-button" })
          ) : h(
            "div",
            { className: "afp-token-line" },
            h("span", { className: "afp-token-state" }, t("authentication"), h(
              Tag,
              { tone: tokenExpired ? "warning" : token?.verifiedAt ? "success" : "neutral" },
              t(tokenExpired ? "tokenExpired" : token?.verifiedAt ? "tokenVerified" : token?.configured ? "tokenUnverified" : "missing")
            )),
            h(Button, {
              variant: "outline",
              size: "sm",
              disabled: busy || !hasCredential("usernameRef") || !hasCredential("passwordRef"),
              "aria-busy": acquiringToken,
              icon: acquiringToken ? h(StateDot, { state: "ongoing", size: 14 }) : null,
              onClick: () => {
                void acquireToken();
              }
            }, acquiringToken ? t("acquiringToken") : t("acquireToken"))
          ),
          token?.configured ? h("p", { className: "afp-muted" }, token.expiresAt == null ? t("tokenExpiryUnknown") : t("tokenExpiry") + ": " + new Date(token.expiresAt).toLocaleString()) : null
        ),
        showVision ? h(
          "section",
          { className: "afp-config-section", ...panelProps("vision") },
          h("h4", { className: "afp-form-heading" }, t("vision")),
          h("div", { className: "afp-config-fields" }, ...(sectionId ? visionFields : [...visionFields, ...budgetFields]).map(loading ? skeletonField : (key) => key === "visionKeyRef" ? credentialField(key) : field(key))),
          sectionId ? h(
            "details",
            { className: "afp-wb-budget" },
            h("summary", null, t("screeningBudget")),
            h("div", { className: "afp-config-fields afp-budget-fields" }, ...budgetFields.map(loading ? skeletonField : field))
          ) : null
        ) : null
      ) : sectionId ? h("div", null, ...["credentials", "vision"].map((value) => h("section", { key: value, ...panelProps(value) }))) : null;
      const editor = loaded ? h("label", { className: "afp-deployment" }, t("deployment"), h("textarea", {
        className: "afp-input",
        rows: 10,
        disabled: busy,
        value: text,
        "aria-label": t("deployment"),
        spellCheck: false,
        onChange: (event) => {
          setText(event.target.value);
          try {
            const value = JSON.parse(event.target.value);
            if (value && typeof value === "object" && !Array.isArray(value)) setDraft(value);
          } catch (error2) {
          }
        }
      })) : loading ? h("span", { className: "afp-skeleton afp-advanced-skeleton", "aria-hidden": true }) : null;
      const error = message ? h("p", { className: "afp-error", role: "alert" }, message) : null;
      const footer = h("div", { className: "afp-config-footer" }, loading ? h("span", { className: "afp-skeleton afp-skeleton-button", "aria-hidden": true }) : h(Button, {
        variant: "primary",
        size: "sm",
        type: "submit",
        disabled: busy || !loaded,
        "aria-busy": busy,
        icon: busy ? h(StateDot, { state: "ongoing", size: 14 }) : null
      }, t("saveConfig")));
      const advanced = sectionId ? h(
        "aside",
        { className: "afp-config-advanced-card", hidden: section !== "vision", "aria-labelledby": `${formId}-advanced-heading` },
        h(
          Button,
          {
            type: "button",
            variant: "ghost",
            size: "sm",
            className: "afp-advanced-toggle",
            id: `${formId}-advanced-heading`,
            "aria-expanded": advancedOpen,
            "aria-controls": `${formId}-advanced-content`,
            onClick: () => setAdvancedOpen((current) => !current)
          },
          h("span", null, t("advanced")),
          Chevron ? h(Chevron, { size: 14 }) : null
        ),
        // 编辑区保持挂载；折叠和分区切换都保留尚未提交的 JSON。
        h(
          "div",
          { className: "afp-advanced-content", id: `${formId}-advanced-content`, hidden: !advancedOpen },
          h("p", { className: "afp-muted" }, t("deploymentHelp")),
          editor
        )
      ) : loaded ? h(
        "details",
        { className: "afp-advanced" },
        h("summary", null, t("advanced")),
        h("p", { className: "afp-muted" }, t("deploymentHelp")),
        editor
      ) : null;
      return h(
        "form",
        {
          className: `afp-configuration${className ? ` ${className}` : ""}`,
          "data-vision": showVision,
          "data-sectioned": Boolean(sectionId),
          "data-section": sectionId ? section : void 0,
          hidden: section === "features",
          "aria-busy": loading,
          onSubmit: (event) => {
            event.preventDefault();
            if (!busy && loaded) void save();
          }
        },
        h("div", { className: "afp-config-scroll" }, sectionId ? h("div", { className: "afp-config-layout" }, h("div", { className: "afp-config-primary" }, columns, error, footer), advanced) : h(React.Fragment, null, columns, advanced, error)),
        sectionId ? null : footer,
        Toast && savedToast ? h(Toast, { key: savedToast, text: savedToast, tone: "success", holdMs: 4e3, onDone: () => setSavedToast("") }) : null
      );
    };
  }

  // src/client/afp-download-overlay.js
  var active = (record) => ["queued", "running"].includes(record.status);
  function createAfpDownloadOverlay(React, UI, icons, t, store, openTasks = () => store.selectTab("tasks")) {
    const h = React.createElement, { Button, Tag, Toast, StateDot, Tooltip, Menu, useDismissOnOutsidePointer } = UI;
    const icon = (name, size = 16) => icons[name] ? h(icons[name], { size }) : null;
    return function DownloadOverlay() {
      const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
      const root = React.useRef(null), trigger = React.useRef(null), card = React.useRef(null), id = React.useId();
      const open = state.downloadDockOpen;
      const [menuOpen, setMenuOpen] = React.useState(false);
      const setOpen = (value) => store.set({ downloadDockOpen: value });
      useDismissOnOutsidePointer(root, open, setOpen);
      React.useEffect(() => {
        if (open) card.current?.focus({ preventScroll: true });
      }, [open]);
      const records = [...state.status?.downloads ?? []];
      const accepted = state.downloadResult;
      if (accepted && !records.some((record) => record.id === accepted.downloadId)) records.push({
        id: accepted.downloadId,
        taskId: accepted.taskId,
        status: "queued",
        total: accepted.total,
        completed: 0,
        failed: 0,
        pending: 0,
        cancelled: 0,
        updatedAt: Date.now(),
        items: []
      });
      records.sort((a, b) => Number(active(b)) - Number(active(a)) || b.updatedAt - a.updatedAt);
      const notice = state.downloadNotice, running = records.filter(active).length;
      if (!records.length && !notice) return null;
      const toast = notice ? h(Toast, {
        key: notice.id,
        text: notice.kind === "started" ? t("downloadStartedNotice").replace("{count}", String(notice.total)) : t("downloadCancelFailed"),
        tone: notice.kind === "started" ? "success" : void 0,
        actions: notice.kind === "started" ? [{ prefix: " \xB7 ", label: t("viewDownloadProgress"), onClick: () => setOpen(true) }] : [],
        onDone: () => store.dismissDownloadNotice(notice.id)
      }) : null;
      const openMenu = () => {
        setOpen(false);
        setMenuOpen(true);
      };
      const edge = h(
        Button,
        {
          ref: trigger,
          className: "afp-download-edge",
          variant: "outline",
          "aria-label": t("viewDownloadProgress"),
          "aria-expanded": open || menuOpen,
          "aria-controls": menuOpen ? void 0 : id,
          "aria-haspopup": "menu",
          onClick: () => {
            setMenuOpen(false);
            setOpen(!open);
          },
          onContextMenu: (event) => {
            event.preventDefault();
            event.stopPropagation();
            openMenu();
          },
          onKeyDown: (event) => {
            if (event.key === "ContextMenu" || event.key === "F10" && event.shiftKey) {
              event.preventDefault();
              event.stopPropagation();
              openMenu();
            }
          }
        },
        h(
          "svg",
          {
            className: "afp-download-glyph" + (running ? " is-running" : ""),
            width: 18,
            height: 18,
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            strokeWidth: 1.7,
            strokeLinecap: "round",
            strokeLinejoin: "round",
            "aria-hidden": true
          },
          h("path", { className: "afp-download-glyph-arrow", d: "M12 3v11m-4-4 4 4 4-4" }),
          h("path", { className: "afp-download-glyph-tray", d: "M4 16v4h16v-4" })
        ),
        h("span", null, String(running || records.length))
      );
      const edgeControl = h(Menu, {
        open: menuOpen,
        anchor: edge,
        portal: true,
        compact: true,
        autoFocus: true,
        side: "top",
        align: "end",
        getAnchorRect: () => trigger.current?.getBoundingClientRect() ?? null,
        onClose: () => setMenuOpen(false),
        items: [
          { id: "progress", label: t("viewDownloadProgress"), icon: icon("IconDownloadOutlineRegular") },
          { id: "tasks", label: t("openDownloadTasks"), icon: icon("IconFlatListOutlineRegular"), disabled: !state.status?.features?.includes("ui-panel") }
        ],
        onSelect: (value) => {
          setMenuOpen(false);
          if (value === "progress") setOpen(true);
          if (value === "tasks" && state.status?.features?.includes("ui-panel")) {
            setOpen(false);
            openTasks();
          }
        }
      });
      return h(
        "div",
        {
          ref: root,
          className: "afp-download-overlay" + (open ? " is-open" : ""),
          onKeyDown: (event) => {
            if (event.key === "Escape" && open) {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              trigger.current?.focus();
            }
          }
        },
        toast,
        records.length ? h(
          React.Fragment,
          null,
          h(
            "div",
            { className: "afp-download-edge-shell" },
            Tooltip ? h(Tooltip, { label: t("viewDownloadProgress"), side: "top", align: "end", maxWidth: 180, disabled: menuOpen || open, portal: true }, edgeControl) : edgeControl
          ),
          h(
            "aside",
            { id, ref: card, tabIndex: -1, className: "afp-download-card", inert: open ? void 0 : "", "aria-hidden": !open, "aria-label": t("downloadProgressTitle") },
            h(
              "header",
              null,
              h("h2", null, t("downloadProgressTitle")),
              running ? h(Tag, { tone: "info" }, String(running)) : null,
              h(Button, { variant: "ghost", size: "sm", className: "afp-wb-close-button", "aria-label": t("collapseDownloadProgress"), onClick: () => {
                setOpen(false);
                trigger.current?.focus();
              } }, icon("IconCloseOutlineRegular", 14))
            ),
            h("div", { className: "afp-download-records" }, ...records.map((record) => {
              const processed = Math.min(record.total, (record.completed ?? 0) + (record.failed ?? 0) + (record.pending ?? 0) + (record.cancelled ?? 0));
              const live = active(record) && record.taskId && (record.taskId === accepted?.taskId || state.status?.tasks?.some((task) => task.taskId === record.taskId));
              const cancelling = state.downloadCancellingId === record.taskId;
              const latest = record.items?.find((item) => item.status === "running") ?? record.items?.findLast((item) => item.status === "completed") ?? record.items?.[0];
              return h(
                "article",
                { key: record.id, className: "afp-download-record" },
                h(
                  "div",
                  { className: "afp-download-record-heading" },
                  active(record) ? h(StateDot, { state: "ongoing", size: 14 }) : null,
                  h("span", null, t("photoCountShort").replace("{count}", String(record.total))),
                  h(Tag, { tone: record.status === "completed" ? "success" : ["partial", "failed", "interrupted"].includes(record.status) ? "warning" : "quiet" }, t(`downloadStatus_${record.status}`))
                ),
                latest ? h("p", { className: "afp-download-file", title: latest.fileName || latest.title }, latest.fileName || latest.title) : null,
                h("progress", { max: Math.max(1, record.total), value: processed, "aria-label": t("downloadProcessed").replace("{count}", String(processed)).replace("{total}", String(record.total)) }),
                h(
                  "div",
                  { className: "afp-download-record-footer" },
                  h("span", null, `${processed}/${record.total} \xB7 ${t("failedCount")} ${record.failed ?? 0}`),
                  live ? h(Button, {
                    variant: "ghost",
                    size: "sm",
                    "data-download-cancel": true,
                    disabled: state.busy,
                    "aria-busy": cancelling,
                    icon: cancelling ? h(StateDot, { state: "ongoing", size: 14 }) : null,
                    onClick: () => {
                      void store.cancelDownload(record.taskId);
                    }
                  }, t("cancel")) : null
                )
              );
            }))
          )
        ) : null
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
    search: "\u641C\u7D22\u56FE\u7247",
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
    visionModel: "\u89C6\u89C9\u6A21\u578BID",
    targetPerCategory: "\u6BCF\u7C7B\u76EE\u6807\u6570\u91CF",
    batchSize: "\u6BCF\u6279\u56FE\u7247\u6570\u91CF",
    maxBatches: "\u6700\u5927\u6279\u6B21\u6570",
    concurrency: "\u5E76\u884C\u4EFB\u52A1\u6570",
    advanced: "\u9AD8\u7EA7\u914D\u7F6E",
    configHelp: "\u5BC6\u94A5\u5355\u72EC\u5199\u5165 DSH \u51ED\u636E\u670D\u52A1\uFF0C\u4E0D\u56DE\u8BFB\u6216\u5199\u5165\u63D2\u4EF6\u914D\u7F6E\uFF1B\u7559\u7A7A\u4FDD\u7559\u5DF2\u6709\u503C\u3002",
    deployment: "\u90E8\u7F72\u914D\u7F6E\uFF08JSON\uFF0C\u4E0D\u542B\u5BC6\u94A5\uFF09",
    deploymentHelp: "\u914D\u7F6E\u63A5\u53E3\u3001\u6A21\u578B\u3001\u51ED\u636E\u5F15\u7528\u540D\u4E0E\u6267\u884C\u9884\u7B97\uFF1B\u4FDD\u5B58\u4F1A\u91CD\u65B0\u52A0\u8F7D\u63D2\u4EF6\u5E76\u53D6\u6D88\u6B63\u5728\u8FD0\u884C\u7684\u4EFB\u52A1\u3002",
    saveCredential: "\u4FDD\u5B58\u51ED\u636E",
    acquireToken: "\u83B7\u53D6\u4EE4\u724C",
    acquiringToken: "\u6B63\u5728\u83B7\u53D6",
    tokenAcquiring: "\u6B63\u5728\u83B7\u53D6\u8BBF\u95EE\u4EE4\u724C\uFF0C\u8BF7\u7A0D\u5019\u2026",
    credentialSaved: "\u51ED\u636E\u5DF2\u4FDD\u5B58\u3002",
    tokenAcquired: "\u5DF2\u83B7\u53D6\u8BBF\u95EE\u4EE4\u724C\u5E76\u5B89\u5168\u4FDD\u5B58\u5728 DSH \u51ED\u636E\u670D\u52A1\u4E2D\u3002",
    tokenCredentialsRequired: "\u8BF7\u5148\u586B\u5199 AFP \u7528\u6237\u540D\u548C\u5BC6\u7801\uFF0C\u518D\u83B7\u53D6\u4EE4\u724C\u3002",
    tokenAcquireFailed: "\u83B7\u53D6\u4EE4\u724C\u5931\u8D25\u3002\u8BF7\u68C0\u67E5\u586B\u5199\u7684 AFP \u7528\u6237\u540D\u3001\u5BC6\u7801\u548C\u7F51\u7EDC\u8FDE\u63A5\u3002",
    saveConfig: "\u4FDD\u5B58\u914D\u7F6E",
    accountConfiguration: "AFP \u8D26\u6237",
    authentication: "\u8BA4\u8BC1\u72B6\u6001",
    keepCredential: "\u7559\u7A7A\u4FDD\u7559\u5DF2\u6709\u503C",
    enterCredential: "\u8BF7\u8F93\u5165",
    maskedCredential: "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022",
    credentialRevealFailed: "\u65E0\u6CD5\u67E5\u770B\u5DF2\u4FDD\u5B58\u7684\u51ED\u636E\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00\u914D\u7F6E\u540E\u91CD\u8BD5",
    showCredential: "\u663E\u793A",
    hideCredential: "\u9690\u85CF",
    tokenExpired: "\u5DF2\u8FC7\u671F",
    tokenVerified: "\u5DF2\u9A8C\u8BC1",
    tokenUnverified: "\u672A\u9A8C\u8BC1",
    tokenExpiry: "\u4EE4\u724C\u6709\u6548\u671F",
    tokenExpiryUnknown: "\u4EE4\u724C\u6709\u6548\u671F\u672A\u77E5",
    threshold: "\u8BC4\u5206\u9608\u503C",
    referenceChangeRequired: "\u8BF7\u5148\u5355\u72EC\u4FDD\u5B58\u51ED\u636E\u5F15\u7528\u540D\uFF0C\u518D\u586B\u5199\u65B0\u7684\u51ED\u636E",
    configUnavailable: "\u65E0\u6CD5\u8BFB\u53D6\u914D\u7F6E\uFF0C\u8BF7\u542F\u7528 AFP \u7EC4\u5408\u5305\u540E\u91CD\u65B0\u6253\u5F00",
    configSaved: "\u90E8\u7F72\u914D\u7F6E\u5DF2\u4FDD\u5B58\uFF0C\u63D2\u4EF6\u6B63\u5728\u91CD\u65B0\u52A0\u8F7D\u3002",
    configFailed: "\u4FDD\u5B58\u6216\u8BFB\u53D6\u5931\u8D25\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00\u5E76\u68C0\u67E5\u914D\u7F6E\u5B57\u6BB5\u3001\u51ED\u636E\u6743\u9650\u53CA profile \u72B6\u6001\u3002",
    workbenchTitle: "AFP \u5DE5\u4F5C\u53F0",
    exampleScope: "\u5F53\u524D profile",
    curator: "\u8D26\u6237",
    accountSettings: "\u8D26\u6237\u8BBE\u7F6E",
    workbenchTabs: "AFP \u5DE5\u4F5C\u53F0\u5206\u533A",
    tab_search: "\u56FE\u5E93\u641C\u7D22",
    tab_collections: "\u6536\u85CF\u5939",
    tab_tasks: "\u7B5B\u9009\u4EFB\u52A1",
    tab_changes: "\u53D8\u66F4\u8BB0\u5F55",
    tab_account: "\u8D26\u6237\u4E0E\u8BBE\u7F6E",
    searchLanguage: "\u8BED\u8A00",
    deploymentDefault: "\u9ED8\u8BA4\u8BED\u8A00",
    language_en: "\u82F1\u8BED",
    language_fr: "\u6CD5\u8BED",
    language_es: "\u897F\u73ED\u7259\u8BED",
    language_ar: "\u963F\u62C9\u4F2F\u8BED",
    language_de: "\u5FB7\u8BED",
    language_pt: "\u8461\u8404\u7259\u8BED",
    searchReady: "\u8F93\u5165\u4E3B\u9898\u641C\u7D22 AFP \u56FE\u7247",
    showingPhotos: "\u5F53\u524D\u663E\u793A",
    originalDensity: "AFP \u9884\u89C8\u56FE",
    searchPrompt: "\u8F93\u5165\u4E3B\u9898\uFF0C\u67E5\u627E AFP \u56FE\u7247",
    openAccountSettings: "\u8D26\u6237\u8BBE\u7F6E",
    working: "\u6B63\u5728\u5904\u7406\u2026",
    loadMore: "\u52A0\u8F7D\u66F4\u591A",
    retry: "\u91CD\u8BD5",
    regionReadFailed: "\u8BFB\u53D6\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5",
    noPhotos: "\u6CA1\u6709\u5339\u914D\u7684\u56FE\u7247",
    noReportItems: "\u6B64\u62A5\u544A\u7B5B\u9009\u4E0B\u6CA1\u6709\u56FE\u7247",
    previewUnavailable: "\u9884\u89C8\u4E0D\u53EF\u7528",
    retryPreview: "\u91CD\u8BD5\u9884\u89C8",
    openPhoto: "\u67E5\u770B\u56FE\u7247\u8BE6\u60C5",
    photoDetails: "\u56FE\u7247\u8BE6\u60C5",
    closeDetails: "\u5173\u95ED\u56FE\u7247\u8BE6\u60C5",
    closeSelection: "\u5173\u95ED\u9009\u56FE\u6E05\u5355",
    close: "\u5173\u95ED",
    photoId: "\u56FE\u7247 ID",
    photoGuid: "GUID",
    provider: "\u6765\u6E90",
    modelConfidence: "\u6A21\u578B\u7F6E\u4FE1\u5EA6",
    requestFailed: "\u8BF7\u6C42\u5931\u8D25",
    kept: "\u4FDD\u7559",
    rejected: "\u6DD8\u6C70",
    notReviewed: "\u5C1A\u672A\u5BA1\u9605",
    selectPhoto: "\u9009\u62E9\u56FE\u7247",
    removeFromSelection: "\u4ECE\u6E05\u5355\u79FB\u9664",
    removePhoto: "\u79FB\u9664\u56FE\u7247",
    selectionList: "\u9009\u56FE\u6E05\u5355",
    selectionEmpty: "\u5C1A\u672A\u9009\u62E9\u56FE\u7247",
    addToCollection: "\u52A0\u5165\u6536\u85CF\u5939",
    manualWriteUnavailable: "\u6682\u672A\u5F00\u653E\u624B\u52A8\u9009\u56FE\u5199\u5165 AFP",
    clearSelection: "\u6E05\u7A7A\u6E05\u5355",
    filterCollections: "\u7B5B\u9009\u6536\u85CF\u5939",
    noCollections: "\u6CA1\u6709\u5339\u914D\u7684\u6536\u85CF\u5939",
    private: "\u79C1\u6709",
    sharedReadOnly: "\u5171\u4EAB \xB7 \u53EA\u8BFB",
    readOnly: "\u53EA\u8BFB",
    photoCount: "\u56FE\u7247\u6570",
    selectCollection: "\u9009\u62E9\u6536\u85CF\u5939",
    collectionPrompt: "\u9009\u62E9\u6536\u85CF\u5939\u67E5\u770B AFP \u56FE\u7247",
    runHistory: "\u7B5B\u9009\u62A5\u544A",
    noRunHistory: "\u6682\u65E0\u5DF2\u4FDD\u5B58\u7684\u7B5B\u9009\u62A5\u544A",
    dateUnknown: "\u65E5\u671F\u672A\u77E5",
    runStatus_created: "\u5DF2\u521B\u5EFA",
    runStatus_running: "\u8FD0\u884C\u4E2D",
    runStatus_ready: "\u53EF\u4F9B\u5BA1\u9605",
    runStatus_paused: "\u7ED3\u679C\u53EF\u7528",
    runStatus_failed: "\u5931\u8D25",
    runStatus_cancelled: "\u5DF2\u53D6\u6D88",
    liveTasks: "\u8FD0\u884C\u4EFB\u52A1",
    noLiveTasks: "\u6682\u65E0\u8FD0\u884C\u4E2D\u7684\u4EFB\u52A1",
    writeTask: "\u6536\u85CF\u5939\u5199\u5165",
    refreshTask: "\u89C6\u89C9\u7B5B\u9009",
    keptCount: "\u4FDD\u7559",
    batch: "\u6279\u6B21",
    newRefresh: "\u65B0\u5EFA\u7B5B\u9009",
    enabled: "\u5DF2\u542F\u7528",
    disabled: "\u672A\u542F\u7528",
    categories: "\u5206\u7C7B",
    refreshPrerequisite: "\u8BF7\u5148\u914D\u7F6E AFP \u8D26\u6237\u4E0E\u89C6\u89C9\u6A21\u578B\uFF0C\u5E76\u542F\u7528\u7B5B\u9009",
    startRefresh: "\u5F00\u59CB\u7B5B\u9009",
    resumeRunId: "\u5DF2\u4FDD\u5B58\u7684 run ID",
    refreshInvalidValues: "\u6570\u91CF\u987B\u4E3A 1\u20131000 \u7684\u6574\u6570\uFF0C\u8BC4\u5206\u4E3A 0.8\u20131",
    resumeRun: "\u7EE7\u7EED\u5DF2\u4FDD\u5B58\u4EFB\u52A1",
    runReport: "\u7B5B\u9009\u62A5\u544A",
    closeReport: "\u5173\u95ED\u62A5\u544A",
    reviewedCount: "\u5DF2\u5BA1\u9605",
    requestFailures: "\u8BF7\u6C42\u5931\u8D25",
    categoryFilter: "\u5206\u7C7B",
    allCategories: "\u5168\u90E8\u5206\u7C7B",
    decisionFilter: "\u7ED3\u679C",
    filter_all: "\u5168\u90E8\u8BB0\u5F55",
    filter_kept: "\u4FDD\u7559",
    filter_rejected: "\u6DD8\u6C70",
    filter_failed: "\u8BF7\u6C42\u5931\u8D25",
    reportEvidenceLabel: "\u62A5\u544A\u8BB0\u5F55 \xB7 \u53EF\u80FD\u4EC5\u663E\u793A\u90E8\u5206\u6761\u76EE",
    noReviewedItems: "\u6B64\u62A5\u544A\u5C1A\u65E0\u5DF2\u5BA1\u9605\u56FE\u7247",
    previewWrite: "\u9884\u89C8\u6536\u85CF\u5939\u53D8\u66F4",
    changePreview: "\u9884\u89C8\u6536\u85CF\u5939\u53D8\u66F4",
    writeDisabled: "\u542F\u7528\u6536\u85CF\u5939\u5199\u5165\u540E\u624D\u80FD\u751F\u6210\u9884\u89C8",
    sourceReport: "\u5DF2\u4FDD\u5B58\u7684\u7B5B\u9009\u62A5\u544A",
    chooseReport: "\u9009\u62E9\u5DF2\u4FDD\u5B58\u7684\u62A5\u544A",
    settledRunRequired: "\u8BF7\u9009\u62E9\u5DF2\u5B8C\u6210\u4E14\u6CA1\u6709\u5F85\u5904\u7406\u6279\u6B21\u7684\u62A5\u544A",
    writePreview: "\u5199\u5165\u9884\u89C8",
    existingCount: "\u73B0\u6709\u6570\u91CF",
    createTarget: "\u521B\u5EFA\u79C1\u6709\u6536\u85CF\u5939",
    confirmRead: "\u6211\u5DF2\u68C0\u67E5\u8FD9\u4E9B\u76EE\u6807\u548C\u6570\u91CF",
    expired: "\u5DF2\u8FC7\u671F",
    previewReady: "\u9884\u89C8\u6709\u6548",
    planHistory: "\u6536\u85CF\u5939\u53D8\u66F4\u5386\u53F2",
    removedCount: "\u5DF2\u5220\u9664",
    addedCount: "\u5DF2\u65B0\u589E",
    planStatus_planned: "\u7B49\u5F85\u786E\u8BA4",
    planStatus_executing: "\u8FDB\u884C\u4E2D",
    planStatus_running: "\u8FDB\u884C\u4E2D",
    planStatus_completed: "\u5DF2\u5B8C\u6210",
    planStatus_failed: "\u90E8\u5206\u5931\u8D25",
    planStatus_cancelled: "\u5DF2\u53D6\u6D88",
    planned: "\u7B49\u5F85\u786E\u8BA4",
    refreshSubmitted: "\u7B5B\u9009\u4EFB\u52A1\u5DF2\u63D0\u4EA4",
    writeSubmitted: "\u5199\u5165\u4EFB\u52A1\u5DF2\u63D0\u4EA4\uFF0C\u8BF7\u5728\u53D8\u66F4\u8BB0\u5F55\u67E5\u770B\u7ED3\u679C",
    executing: "\u8FDB\u884C\u4E2D",
    completed: "\u5DF2\u5B8C\u6210",
    failed: "\u5931\u8D25",
    cancelled: "\u5DF2\u53D6\u6D88",
    accountSummary: "AFP \u8D26\u6237",
    username: "\u7528\u6237\u540D",
    profile: "Profile",
    unknown: "\u672A\u77E5",
    verifiedAt: "\u9A8C\u8BC1\u65F6\u95F4",
    featureSettings: "\u529F\u80FD\u4E0E\u9875\u9762\u5165\u53E3",
    visionAndCredentials: "\u8D26\u6237\u4E0E\u6A21\u578B\u914D\u7F6E",
    accountLoading: "\u6B63\u5728\u52A0\u8F7D\u8D26\u6237\u8BBE\u7F6E\u2026",
    operationFailed: "\u64CD\u4F5C\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u8BBE\u7F6E\u540E\u91CD\u8BD5",
    accountRequired: "\u914D\u7F6E AFP \u8D26\u6237\u540E\u5373\u53EF\u641C\u7D22\u56FE\u7247",
    accountUnavailable: "\u8D26\u6237\u8BFB\u53D6\u5931\u8D25",
    accountSections: "\u8D26\u6237\u8BBE\u7F6E\u5206\u533A",
    accountSection_credentials: "AFP \u8D26\u6237",
    accountSection_vision: "\u89C6\u89C9\u6A21\u578B",
    accountSection_features: "\u529F\u80FD\u4E0E\u5165\u53E3",
    screeningBudget: "\u7B5B\u9009\u53C2\u6570",
    changeId: "\u53D8\u66F4\u7F16\u53F7",
    noPlanHistory: "\u6682\u65E0\u53D8\u66F4\u8BB0\u5F55",
    previewOnlyHint: "\u5148\u9884\u89C8\uFF0C\u786E\u8BA4\u540E\u624D\u4F1A\u4FEE\u6539\u6536\u85CF\u5939",
    clearPreviewHint: "\u6E05\u7A7A\u524D\u5C06\u9884\u89C8\u5F85\u79FB\u9664\u7684\u56FE\u7247\u6570\u91CF",
    unnamedCollection: "\u672A\u5F52\u6863\u6536\u85CF\u5939",
    documentCount: "\u6587\u6863\u6570\u91CF",
    expandCollections: "\u5C55\u5F00\u6536\u85CF\u5939\u4FA7\u680F",
    collapseCollections: "\u6298\u53E0\u6536\u85CF\u5939\u4FA7\u680F",
    collectionPhotos: "\u6536\u85CF\u5939\u56FE\u7247",
    backToTop: "\u56DE\u5230\u9876\u90E8",
    accountInformation: "\u8D26\u6237\u4FE1\u606F",
    refreshAccount: "\u5237\u65B0\u8D26\u6237\u4FE1\u606F",
    accountReadFailed: "\u8D26\u6237\u4FE1\u606F\u8BFB\u53D6\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5",
    notAvailable: "\u6682\u672A\u63D0\u4F9B",
    creditBalance: "\u79EF\u5206\u4F59\u989D",
    accountEmail: "\u90AE\u7BB1",
    accountId: "\u7528\u6237 ID",
    clientId: "\u5BA2\u6237 ID",
    creditBilling: "\u6309\u79EF\u5206\u8BA1\u8D39",
    subscriptionBilling: "\u975E\u79EF\u5206\u8BA1\u8D39",
    enableReadForAccount: "\u5F00\u542F\u53EA\u8BFB\u5DE5\u5177\u540E\u53EF\u67E5\u770B\u8D26\u6237\u4FE1\u606F",
    loginToViewAccount: "\u83B7\u53D6\u4EE4\u724C\u540E\u663E\u793A\u8D26\u6237\u4FE1\u606F",
    previewHostBlocked: "\u9884\u89C8\u57DF\u540D\u672A\u914D\u7F6E\uFF1A{host}",
    photoIdentifiers: "\u56FE\u7247\u6807\u8BC6",
    moreSelectedPhotos: "\u8FD8\u6709 {count} \u5F20\u5DF2\u9009\u56FE\u7247",
    selectedPhotoCount: "\u5DF2\u9009\u62E9 {count} \u5F20\u56FE\u7247",
    downloadSelection: "\u4E0B\u8F7D\u56FE\u7247",
    removeSelection: "\u79FB\u51FA\u6536\u85CF\u5939",
    transferSelection: "\u8F6C\u79FB\u6536\u85CF\u5939",
    chooseRendition: "\u9009\u62E9\u753B\u8D28",
    downloadQuality: "\u4E0B\u8F7D\u753B\u8D28",
    alreadyAvailable: "\u5DF2\u53EF\u4E0B\u8F7D",
    credits: "\u79EF\u5206",
    free: "\u514D\u8D39",
    saveLocation: "\u4FDD\u5B58\u4F4D\u7F6E",
    chooseDirectory: "\u9009\u62E9\u6587\u4EF6\u5939",
    changeDirectory: "\u66F4\u6539\u6587\u4EF6\u5939",
    filenamePrefix: "\u6587\u4EF6\u540D\u524D\u7F00",
    filenameSuffix: "\u6587\u4EF6\u540D\u540E\u7F00",
    filenameRule: "\u4F18\u5148\u4F7F\u7528 AFP \u8FD4\u56DE\u7684\u539F\u59CB\u6587\u4EF6\u540D\uFF1B\u672A\u63D0\u4F9B\u65F6\u4F7F\u7528 GUID \u6216\u56FE\u7247 ID\u3002\u53EF\u7EC4\u5408\u524D\u7F00\u548C\u540E\u7F00\uFF0C\u91CD\u540D\u6587\u4EF6\u4F1A\u81EA\u52A8\u6DFB\u52A0\u5E8F\u53F7\u3002",
    totalCreditCost: "\u672C\u6B21\u79EF\u5206\u603B\u989D",
    downloadConfirmation: "\u4E0B\u8F7D\u786E\u8BA4",
    confirmDownloadSpend: "\u786E\u8BA4\u652F\u4ED8 {credits} \u79EF\u5206",
    paidDownloadWarning: "\u53EA\u6709\u660E\u786E\u786E\u8BA4\u540E\u624D\u4F1A\u63D0\u4EA4\u4ED8\u8D39\u753B\u8D28\u3002\u82E5 AFP \u5DF2\u53D7\u7406\u8D2D\u4E70\u4F46\u6682\u672A\u8FD4\u56DE\u4E0B\u8F7D\u94FE\u63A5\uFF0C\u4EFB\u52A1\u4F1A\u6807\u4E3A\u5F85\u6838\u5BF9\uFF0C\u4E0D\u4F1A\u81EA\u52A8\u518D\u6B21\u8D2D\u4E70\u3002",
    confirmDownload: "\u786E\u8BA4\u5E76\u4E0B\u8F7D",
    previewDownload: "\u68C0\u67E5\u4E0B\u8F7D",
    downloadSelectionTitle: "\u4E0B\u8F7D\u5DF2\u9009\u56FE\u7247",
    downloadSelectionDescription: "\u4E3A\u6BCF\u5F20\u56FE\u7247\u9009\u62E9\u753B\u8D28\u548C\u4FDD\u5B58\u4F4D\u7F6E\u3002\u9ED8\u8BA4\u9009\u53D6\u53EF\u7528\u7684\u6700\u9AD8\u514D\u8D39\u753B\u8D28\u3002",
    downloadActionFailed: "\u65E0\u6CD5\u51C6\u5907\u4E0B\u8F7D\u3002\u8BF7\u5237\u65B0\u9009\u9879\u540E\u91CD\u8BD5\u3002",
    downloadQuoteChanged: "\u79EF\u5206\u4F59\u989D\u6216\u753B\u8D28\u62A5\u4EF7\u5DF2\u53D8\u5316\uFF0C\u8BF7\u68C0\u67E5\u66F4\u65B0\u540E\u7684\u603B\u989D\u5E76\u91CD\u65B0\u786E\u8BA4\u3002",
    downloadQueued: "\u4E0B\u8F7D\u4EFB\u52A1\u5DF2\u52A0\u5165\u540E\u53F0\uFF0C\u53EF\u5728\u4EFB\u52A1\u9875\u67E5\u770B\u8FDB\u5EA6\u548C\u7ED3\u679C\u3002",
    removeFavoritesTitle: "\u79FB\u51FA\u6536\u85CF\u5939",
    removeFavoritesWarning: "\u53EA\u89E3\u9664\u6240\u9009\u56FE\u7247\u4E0E\u5176\u6765\u6E90\u6536\u85CF\u5939\u7684\u5173\u8054\uFF0C\u4E0D\u4F1A\u5220\u9664 AFP \u56FE\u7247\u3002\u6BCF\u9879\u64CD\u4F5C\u5B8C\u6210\u540E\u90FD\u4F1A\u6838\u5BF9\u7ED3\u679C\u3002",
    removeFromFavorites: "\u79FB\u51FA\u6240\u9009\u56FE\u7247",
    operationResult: "\u5DF2\u5B8C\u6210 {count} \u9879",
    pending: "\u5F85\u6838\u5BF9",
    copy: "\u590D\u5236\u5230\u6536\u85CF\u5939",
    move: "\u79FB\u52A8\u5230\u6536\u85CF\u5939",
    moveSourceRequired: "\u6765\u6E90\u6536\u85CF\u5939\u4E0D\u53EF\u5199\u6216\u6765\u6E90\u4E0D\u660E\u786E\uFF0C\u65E0\u6CD5\u79FB\u52A8\u8FD9\u4E9B\u56FE\u7247\u3002",
    targetCollection: "\u76EE\u6807\u6536\u85CF\u5939",
    chooseTarget: "\u9009\u62E9\u76EE\u6807\u6536\u85CF\u5939",
    collectionActionFailed: "\u6536\u85CF\u5939\u64CD\u4F5C\u5931\u8D25\uFF0C\u8BF7\u5237\u65B0\u72B6\u6001\u540E\u6838\u5BF9\u7ED3\u679C\u3002",
    transferSelectionTitle: "\u8F6C\u79FB\u6240\u9009\u56FE\u7247",
    confirmTransfer: "\u786E\u8BA4\u8F6C\u79FB",
    partial: "\u90E8\u5206\u5B8C\u6210",
    downloadTasks: "\u4E0B\u8F7D\u8BB0\u5F55",
    downloadTask: "\u56FE\u7247\u4E0B\u8F7D",
    failedCount: "\u5931\u8D25",
    pendingCount: "\u5F85\u5904\u7406",
    purchasePending: "AFP \u5DF2\u53D7\u7406\u8D2D\u4E70\uFF0C\u4F46\u6682\u672A\u786E\u8BA4\u4E0B\u8F7D\u4EA4\u4ED8\uFF1B\u4E0D\u4F1A\u81EA\u52A8\u91CD\u590D\u8D2D\u4E70\u3002\u8BF7\u7A0D\u540E\u6838\u5BF9\u8D26\u6237\u3002",
    hostStopped: "Host \u9000\u51FA\u65F6\u4EFB\u52A1\u505C\u6B62\u3002",
    downloadStatus_queued: "\u6392\u961F\u4E2D",
    downloadStatus_running: "\u4E0B\u8F7D\u4E2D",
    downloadStatus_completed: "\u5DF2\u5B8C\u6210",
    downloadStatus_partial: "\u90E8\u5206\u5B8C\u6210",
    downloadStatus_failed: "\u5931\u8D25",
    downloadStatus_pending: "\u5F85\u5904\u7406",
    downloadStatus_cancelled: "\u5DF2\u53D6\u6D88",
    downloadStatus_interrupted: "Host \u5173\u95ED\u540E\u4E2D\u65AD",
    downloadDefaultQuality: "\u9ED8\u8BA4\u9009\u62E9\u6700\u9AD8\u53EF\u7528\u514D\u8D39\u753B\u8D28",
    photoCountShort: "{count} \u5F20",
    refreshOptions: "\u5237\u65B0\u753B\u8D28",
    downloadChooseLocation: "\u5C1A\u672A\u9009\u62E9\u6587\u4EF6\u5939",
    filenameCustomization: "\u6587\u4EF6\u547D\u540D",
    downloadOriginalName: "\u539F\u59CB\u6587\u4EF6\u540D",
    downloadCustomizedName: "\u5DF2\u81EA\u5B9A\u4E49\u524D\u540E\u7F00",
    filenamePrefixExample: "\u4F8B\u5982\uFF1Abatch_",
    filenameSuffixExample: "\u4F8B\u5982\uFF1A_final",
    filenamePreview: "\u672A\u8FD4\u56DE\u539F\u59CB\u6587\u4EF6\u540D\u65F6\u7684\u547D\u540D\u9884\u89C8",
    downloadFilenameHint: "\u539F\u59CB\u6587\u4EF6\u540D\u5728\u63A5\u6536\u6587\u4EF6\u65F6\u786E\u5B9A\uFF1B\u672A\u63D0\u4F9B\u65F6\u91C7\u7528\u4E0A\u8FF0\u540D\u79F0\uFF0C\u6269\u5C55\u540D\u4EE5\u5B9E\u9645\u683C\u5F0F\u4E3A\u51C6",
    downloadAvailableCount: "\u53EF\u4E0B\u8F7D {count}/{total} \u5F20\uFF1B\u672A\u53D6\u5F97\u753B\u8D28\u7684\u56FE\u7247\u4E0D\u4F1A\u8FDB\u5165\u672C\u6B21\u4E0B\u8F7D",
    downloadReviewed: "\u5DF2\u6838\u5BF9 {count} \u5F20",
    downloadFreeConfirmed: "\u672C\u6B21\u4E0D\u6263\u79EF\u5206",
    downloadQuotePending: "\u7B49\u5F85\u753B\u8D28",
    downloadStartBackground: "\u5F00\u59CB\u540E\u53F0\u4E0B\u8F7D",
    viewDownloadTasks: "\u67E5\u770B\u4EFB\u52A1",
    downloadServiceOutdated: "\u4E0B\u8F7D\u670D\u52A1\u5C1A\u672A\u66F4\u65B0\uFF0C\u8BF7\u91CD\u542F Host \u540E\u91CD\u8BD5",
    downloadResponseTooLarge: "\u4E0B\u8F7D\u9009\u9879\u8FC7\u591A\uFF0C\u8BF7\u51CF\u5C11\u9009\u62E9\u540E\u91CD\u8BD5",
    downloadAuthFailed: "AFP \u8BA4\u8BC1\u4E0D\u53EF\u7528\uFF0C\u8BF7\u68C0\u67E5\u8D26\u6237\u540E\u91CD\u8BD5",
    downloadPhotoFailed: "\u56FE\u7247\u6682\u4E0D\u53EF\u8BBF\u95EE\uFF0C\u8BF7\u5237\u65B0\u753B\u8D28\u91CD\u8BD5",
    downloadNoRenditions: "\u6682\u65E0\u53EF\u4E0B\u8F7D\u753B\u8D28",
    downloadBalanceRequired: "\u672A\u80FD\u83B7\u53D6\u79EF\u5206\u4F59\u989D\uFF0C\u8BF7\u5237\u65B0\u753B\u8D28\u540E\u518D\u9009\u62E9\u4ED8\u8D39\u683C\u5F0F",
    downloadInsufficientCredit: "\u79EF\u5206\u4F59\u989D\u4E0D\u8DB3\uFF0C\u8BF7\u8C03\u6574\u753B\u8D28",
    downloadPickerUnavailable: "\u6B64 Host \u672A\u63D0\u4F9B\u7CFB\u7EDF\u76EE\u5F55\u9009\u62E9\u5668",
    downloadDirectoryExpired: "\u4FDD\u5B58\u4F4D\u7F6E\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9\u6587\u4EF6\u5939",
    downloadOptionsExpired: "\u753B\u8D28\u4FE1\u606F\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u5237\u65B0",
    downloadConfirmationExpired: "\u786E\u8BA4\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u68C0\u67E5\u4E0B\u8F7D",
    downloadAccountChanged: "AFP \u8D26\u6237\u5DF2\u53D8\u66F4\uFF0C\u8BF7\u5237\u65B0\u4E0B\u8F7D\u9009\u9879\u5E76\u91CD\u65B0\u786E\u8BA4\u3002",
    downloadPaidDisabled: "\u4ED8\u8D39\u753B\u8D28\u9700\u542F\u7528\u8FDC\u7AEF\u5199\u5165\u529F\u80FD",
    downloadOptionsFailed: "\u672A\u80FD\u8BFB\u53D6\u753B\u8D28\uFF0C\u8BF7\u91CD\u8BD5\u6216\u68C0\u67E5 AFP \u8D26\u6237\u72B6\u6001",
    downloadDirectoryFailed: "\u65E0\u6CD5\u9009\u62E9\u4FDD\u5B58\u4F4D\u7F6E\uFF0C\u8BF7\u91CD\u8BD5\u5E76\u68C0\u67E5\u76EE\u5F55\u6743\u9650",
    downloadPrepareFailed: "\u65E0\u6CD5\u6838\u5BF9\u4E0B\u8F7D\uFF0C\u8BF7\u5237\u65B0\u753B\u8D28\u540E\u91CD\u8BD5",
    downloadConfirmFailed: "\u4E0B\u8F7D\u63D0\u4EA4\u672A\u786E\u8BA4\uFF0C\u8BF7\u5148\u67E5\u770B\u4EFB\u52A1\u8BB0\u5F55\uFF0C\u518D\u51B3\u5B9A\u662F\u5426\u91CD\u8BD5",
    cancelDownloadSetup: "\u53D6\u6D88",
    choosingDirectory: "\u9009\u62E9\u4E2D\u2026",
    checkingDownload: "\u6B63\u5728\u6838\u5BF9\u2026",
    submittingDownload: "\u6B63\u5728\u63D0\u4EA4\u2026",
    downloadStartedNotice: "\u5DF2\u5F00\u59CB\u540E\u53F0\u4E0B\u8F7D {count} \u5F20\u56FE\u7247",
    viewDownloadProgress: "\u67E5\u770B\u4E0B\u8F7D\u8FDB\u5EA6",
    downloadProgressTitle: "\u540E\u53F0\u4E0B\u8F7D",
    collapseDownloadProgress: "\u6536\u8D77\u4E0B\u8F7D\u8FDB\u5EA6",
    downloadProcessed: "\u5DF2\u5904\u7406 {count}/{total} \u5F20\u56FE\u7247",
    downloadCancelFailed: "\u65E0\u6CD5\u53D6\u6D88\u4E0B\u8F7D\uFF0C\u8BF7\u91CD\u8BD5",
    bulkQualityTitle: "\u6279\u91CF\u9009\u62E9\u753B\u8D28",
    bulkQualityFree: "\u6700\u9AD8\u514D\u8D39\u753B\u8D28",
    bulkQualityHighest: "\u6700\u9AD8\u53EF\u7528\u753B\u8D28",
    bulkQualityApplied: "\u5DF2\u5E94\u7528 {count}/{total}",
    bulkQualityUnmatched: "\u5176\u4F59\u56FE\u7247\u6CA1\u6709\u5339\u914D\u753B\u8D28\uFF0C\u4FDD\u7559\u539F\u9009\u62E9",
    selectAllCollection: "\u5168\u9009",
    deselectCollection: "\u53D6\u6D88\u5168\u9009",
    cancelSelectAll: "\u53D6\u6D88\u8BFB\u53D6",
    selectAllFailed: "\u65E0\u6CD5\u5168\u9009\u56FE\u7247\uFF0C\u8BF7\u91CD\u8BD5",
    downloadSelectionLimit: "\u5355\u6B21\u6700\u591A\u4E0B\u8F7D 120 \u5F20\uFF0C\u8BF7\u51CF\u5C11\u9009\u56FE",
    openDownloadTasks: "\u6253\u5F00\u4E0B\u8F7D\u4EFB\u52A1",
    keywordSuggestions: "\u63A8\u8350\u5173\u952E\u8BCD",
    skillKeywords: "Skill \u8BCD\u5E93",
    suggestionCategories: "\u5173\u952E\u8BCD\u5206\u7C7B",
    noKeywordSuggestions: "\u6682\u65E0\u5339\u914D\u5173\u952E\u8BCD\uFF0C\u53EF\u76F4\u63A5\u641C\u7D22\u5F53\u524D\u8F93\u5165",
    keywordSuggestionHint: "\u2191 \u2193 \u9009\u62E9 \xB7 Enter \u586B\u5165 \xB7 \u518D\u6B21 Enter \u641C\u7D22 \xB7 Esc \u6536\u8D77",
    addFavorites: "\u52A0\u5165\u6536\u85CF\u5939",
    addFavoritesHelp: "\u5C06\u8FD9\u6279\u56FE\u7247\u52A0\u5165\u79C1\u6709\u6536\u85CF\u5939\uFF0C\u4FDD\u7559\u539F\u6709\u6536\u85CF\u5173\u7CFB\u3002",
    confirmAddFavorites: "\u786E\u8BA4\u52A0\u5165",
    addingFavorites: "\u6B63\u5728\u52A0\u5165",
    noMatchingCollections: "\u6CA1\u6709\u5339\u914D\u7684\u6536\u85CF\u5939",
    noWritableCollections: "\u6682\u65E0\u53EF\u5199\u7684\u5DF2\u547D\u540D\u79C1\u6709\u6536\u85CF\u5939",
    favoritesPermissionsRequired: "\u9700\u8981\u542F\u7528\u8BFB\u53D6\u4E0E\u5199\u5165\u529F\u80FD",
    favoritesWriteUncertain: "\u672A\u80FD\u83B7\u53D6\u5199\u5165\u7ED3\u679C\u3002\u8BF7\u5148\u68C0\u67E5\u76EE\u6807\u6536\u85CF\u5939\uFF0C\u518D\u51B3\u5B9A\u662F\u5426\u91CD\u8BD5\u3002",
    favoritesAdded: "\u65B0\u52A0\u5165 {count} \u5F20",
    favoritesExisting: "\u5DF2\u5B58\u5728 {count} \u5F20",
    favoritesCompleted: "\u5DF2\u5B8C\u6210 {count} \u5F20",
    favoritesFailed: "\u5931\u8D25 {count} \u5F20",
    favoritesPending: "\u5F85\u6838\u5B9E {count} \u5F20",
    favoritesPartialHelp: "\u4EE5\u4E0B\u56FE\u7247\u672A\u786E\u8BA4\u52A0\u5165\uFF1B\u8BF7\u68C0\u67E5\u76EE\u6807\u6536\u85CF\u5939\u540E\u518D\u5904\u7406\u3002",
    favoritesPendingLabel: "\u5F85\u6838\u5B9E",
    favoritesSelectionLimit: "\u5355\u6B21\u6700\u591A\u52A0\u5165 120 \u5F20\uFF0C\u8BF7\u51CF\u5C11\u9009\u56FE",
    loadMoreFailed: "\u52A0\u8F7D\u4E0B\u4E00\u9875\u5931\u8D25\uFF0C\u5DF2\u6709\u56FE\u7247\u5DF2\u4FDD\u7559",
    paginationPaused: "\u672C\u9875\u672A\u65B0\u589E\u56FE\u7247\u6216\u5206\u9875\u6E38\u6807\u91CD\u590D\uFF0C\u5DF2\u6682\u505C\u7FFB\u9875\uFF1B\u53EF\u4EE5\u91CD\u65B0\u641C\u7D22"
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
    search: "Search photos",
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
    visionModel: "Vision model ID",
    targetPerCategory: "Target per category",
    batchSize: "Images per batch",
    maxBatches: "Maximum batches",
    concurrency: "Concurrent tasks",
    advanced: "Advanced settings",
    configHelp: "Secrets go separately to DSH credentials, never read back or stored in plugin config. Blank fields preserve existing values.",
    deployment: "Deployment settings (JSON, no secrets)",
    deploymentHelp: "Edit endpoints, models, credential references and budgets. Saving reloads the plugin and cancels active tasks.",
    saveCredential: "Save credential",
    acquireToken: "Get token",
    acquiringToken: "Getting token",
    tokenAcquiring: "Getting access token\u2026",
    credentialSaved: "Credential saved.",
    tokenAcquired: "The access token was acquired and securely stored in DSH credentials.",
    tokenCredentialsRequired: "Enter the AFP username and password before getting a token.",
    tokenAcquireFailed: "Could not get an access token. Check the entered AFP username, password and network connection.",
    saveConfig: "Save configuration",
    accountConfiguration: "AFP account",
    authentication: "Authentication",
    keepCredential: "Leave blank to keep the saved value",
    enterCredential: "Enter a value",
    maskedCredential: "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022",
    credentialRevealFailed: "Could not reveal the saved credential. Reopen configuration and try again.",
    showCredential: "Show",
    hideCredential: "Hide",
    tokenExpired: "Expired",
    tokenVerified: "Verified",
    tokenUnverified: "Not verified",
    tokenExpiry: "Token expires",
    tokenExpiryUnknown: "Token expiry is unknown",
    threshold: "Score threshold",
    referenceChangeRequired: "Save credential reference names before entering replacement credentials",
    configUnavailable: "Configuration is unavailable. Enable the AFP bundle and reopen this editor",
    configSaved: "Deployment settings saved. The plugin is reloading.",
    configFailed: "Read or save failed. Reopen and check settings, credential permissions and profile status.",
    workbenchTitle: "AFP Workbench",
    exampleScope: "Current profile",
    curator: "Account",
    accountSettings: "Account settings",
    workbenchTabs: "AFP workbench sections",
    tab_search: "Photo search",
    tab_collections: "Collections",
    tab_tasks: "Refresh tasks",
    tab_changes: "Change history",
    tab_account: "Account and settings",
    searchLanguage: "Language",
    deploymentDefault: "Default language",
    language_en: "English",
    language_fr: "French",
    language_es: "Spanish",
    language_ar: "Arabic",
    language_de: "German",
    language_pt: "Portuguese",
    searchReady: "Search AFP photos with a topic",
    showingPhotos: "Photos shown",
    originalDensity: "AFP previews",
    searchPrompt: "Enter a topic to find AFP photos",
    openAccountSettings: "Account settings",
    working: "Working\u2026",
    loadMore: "Load more",
    retry: "Retry",
    regionReadFailed: "Could not load this section. Try again",
    noPhotos: "No matching photos",
    noReportItems: "No items in this report filter",
    previewUnavailable: "Preview unavailable",
    retryPreview: "Retry preview",
    openPhoto: "Open photo details",
    photoDetails: "Photo details",
    closeDetails: "Close photo details",
    closeSelection: "Close selection list",
    close: "Close",
    photoId: "Photo ID",
    photoGuid: "GUID",
    provider: "Provider",
    modelConfidence: "Model confidence",
    requestFailed: "Request failed",
    kept: "Kept",
    rejected: "Rejected",
    notReviewed: "Not reviewed",
    selectPhoto: "Select photo",
    removeFromSelection: "Remove from selection",
    removePhoto: "Remove photo",
    selectionList: "Selected photos",
    selectionEmpty: "No photos selected",
    addToCollection: "Add to collection",
    manualWriteUnavailable: "Manual photo selection cannot be written to AFP yet",
    clearSelection: "Clear selection",
    filterCollections: "Filter collections",
    noCollections: "No collections match this filter",
    private: "Private",
    sharedReadOnly: "Shared \xB7 read-only",
    readOnly: "Read-only",
    photoCount: "Photos",
    selectCollection: "Select a collection",
    collectionPrompt: "Choose a collection to view its AFP photos",
    runHistory: "Screening reports",
    noRunHistory: "No saved refresh reports",
    dateUnknown: "Date unavailable",
    runStatus_created: "Created",
    runStatus_running: "Running",
    runStatus_ready: "Ready to review",
    runStatus_paused: "Results available",
    runStatus_failed: "Failed",
    runStatus_cancelled: "Cancelled",
    liveTasks: "Running tasks",
    noLiveTasks: "No running tasks",
    writeTask: "Collection write",
    refreshTask: "Visual refresh",
    keptCount: "Kept",
    batch: "Batch",
    newRefresh: "New visual refresh",
    enabled: "Enabled",
    disabled: "Disabled",
    categories: "Categories",
    refreshPrerequisite: "Configure AFP and vision, and enable screening",
    startRefresh: "Start refresh",
    resumeRunId: "Saved run ID",
    refreshInvalidValues: "Use a whole number from 1 to 1000 and a score from 0.8 to 1",
    resumeRun: "Resume saved run",
    runReport: "Refresh report",
    closeReport: "Close report",
    reviewedCount: "Reviewed",
    requestFailures: "Request failures",
    categoryFilter: "Category",
    allCategories: "All categories",
    decisionFilter: "Decision",
    filter_all: "All items",
    filter_kept: "Kept",
    filter_rejected: "Rejected",
    filter_failed: "Request failed",
    reportEvidenceLabel: "Report evidence \xB7 partial records may be shown",
    noReviewedItems: "No reviewed photos in this report",
    previewWrite: "Preview collection changes",
    changePreview: "Preview a collection change",
    writeDisabled: "Enable collection writes to create a preview",
    sourceReport: "Saved refresh report",
    chooseReport: "Choose a saved report",
    settledRunRequired: "Choose a ready report with no pending batch",
    writePreview: "Write preview",
    existingCount: "Existing",
    createTarget: "Create private collection",
    confirmRead: "I reviewed these targets and counts",
    expired: "Expired",
    previewReady: "Preview ready",
    planHistory: "Collection change history",
    removedCount: "Removed",
    addedCount: "Added",
    planStatus_planned: "Awaiting confirmation",
    planStatus_executing: "In progress",
    planStatus_running: "In progress",
    planStatus_completed: "Completed",
    planStatus_failed: "Partially failed",
    planStatus_cancelled: "Cancelled",
    planned: "Awaiting confirmation",
    refreshSubmitted: "Visual refresh task submitted",
    writeSubmitted: "Collection write task submitted. Check the change history for results",
    executing: "In progress",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    accountSummary: "AFP account",
    username: "Username",
    profile: "Profile",
    unknown: "Unknown",
    verifiedAt: "Verified",
    featureSettings: "Features and entry points",
    visionAndCredentials: "Account and model settings",
    accountLoading: "Loading account settings\u2026",
    operationFailed: "The operation failed. Check your settings and retry",
    accountRequired: "Configure your AFP account to search photos",
    accountUnavailable: "Account unavailable",
    accountSections: "Account settings sections",
    accountSection_credentials: "AFP account",
    accountSection_vision: "Vision model",
    accountSection_features: "Features & entries",
    screeningBudget: "Screening parameters",
    changeId: "Change ID",
    noPlanHistory: "No changes yet",
    previewOnlyHint: "Preview first; collections change only after confirmation",
    clearPreviewHint: "Preview the number of photos to remove before clearing",
    unnamedCollection: "Unfiled collection",
    documentCount: "Document count",
    expandCollections: "Expand collections sidebar",
    collapseCollections: "Collapse collections sidebar",
    collectionPhotos: "Collection photos",
    backToTop: "Back to top",
    accountInformation: "Account information",
    refreshAccount: "Refresh account information",
    accountReadFailed: "Unable to read account information. Try again.",
    notAvailable: "Not available",
    creditBalance: "Credit balance",
    accountEmail: "Email",
    accountId: "User ID",
    clientId: "Client ID",
    creditBilling: "Credit billing",
    subscriptionBilling: "Not billed by credits",
    enableReadForAccount: "Enable read-only tools to view account information",
    loginToViewAccount: "Get an access token to view account information",
    previewHostBlocked: "Preview host is not configured: {host}",
    photoIdentifiers: "Photo identifiers",
    moreSelectedPhotos: "{count} more selected photos",
    selectedPhotoCount: "{count} photos selected",
    downloadSelection: "Download photos",
    removeSelection: "Remove from favorites",
    transferSelection: "Transfer favorites",
    chooseRendition: "Choose a quality",
    downloadQuality: "Download quality",
    alreadyAvailable: "Already available",
    credits: "credits",
    free: "Free",
    saveLocation: "Save location",
    chooseDirectory: "Choose folder",
    changeDirectory: "Change folder",
    filenamePrefix: "Filename prefix",
    filenameSuffix: "Filename suffix",
    filenameRule: "Use the delivered filename when AFP provides one; otherwise use the GUID or photo ID. Prefixes and suffixes combine, and duplicate names receive a number.",
    totalCreditCost: "Total credits",
    downloadConfirmation: "Download confirmation",
    confirmDownloadSpend: "Confirm spending {credits} credits",
    paidDownloadWarning: "Paid qualities are submitted only after confirmation. If AFP accepts a purchase but does not return a delivery URL, the task is marked for review and is never purchased again automatically.",
    confirmDownload: "Confirm and download",
    previewDownload: "Review download",
    downloadSelectionTitle: "Download selected photos",
    downloadSelectionDescription: "Choose a quality and save location for each photo. The highest available free quality is selected by default.",
    downloadActionFailed: "Could not prepare the download. Refresh the options and try again.",
    downloadQuoteChanged: "The credit balance or quality quote changed. Review the updated total and confirm again.",
    downloadQueued: "The download is running in the background. Check Tasks for progress and results.",
    removeFavoritesTitle: "Remove from favorites",
    removeFavoritesWarning: "This only removes the selected photos from their source collections. It does not delete AFP photos. Each change is verified.",
    removeFromFavorites: "Remove selected photos",
    operationResult: "{count} completed",
    pending: "Pending review",
    copy: "Copy to collection",
    move: "Move to collection",
    moveSourceRequired: "These photos cannot be moved because their source collection is read-only or unknown.",
    targetCollection: "Target collection",
    chooseTarget: "Choose a target collection",
    collectionActionFailed: "The collection operation failed. Refresh the state and review the result.",
    transferSelectionTitle: "Transfer selected photos",
    confirmTransfer: "Confirm transfer",
    partial: "Partially complete",
    downloadTasks: "Download history",
    downloadTask: "Photo download",
    failedCount: "Failed",
    pendingCount: "Pending",
    purchasePending: "AFP accepted the purchase, but delivery is not confirmed. It will not be purchased again automatically. Check the account later.",
    hostStopped: "The task stopped when the Host exited.",
    downloadStatus_queued: "Queued",
    downloadStatus_running: "Downloading",
    downloadStatus_completed: "Completed",
    downloadStatus_partial: "Partially complete",
    downloadStatus_failed: "Failed",
    downloadStatus_pending: "Pending review",
    downloadStatus_cancelled: "Cancelled",
    downloadStatus_interrupted: "Interrupted when Host stopped",
    downloadDefaultQuality: "The highest available free quality is selected",
    photoCountShort: "{count} photos",
    refreshOptions: "Refresh qualities",
    downloadChooseLocation: "No folder selected",
    filenameCustomization: "File naming",
    downloadOriginalName: "Original filename",
    downloadCustomizedName: "Custom affixes",
    filenamePrefixExample: "For example: batch_",
    filenameSuffixExample: "For example: _final",
    filenamePreview: "Name preview when AFP supplies no original filename",
    downloadFilenameHint: "The original filename is determined on delivery. Otherwise this name is used, with the actual image extension.",
    downloadAvailableCount: "{count}/{total} photos available. Photos without a quality will not be downloaded.",
    downloadReviewed: "{count} photos reviewed",
    downloadFreeConfirmed: "No credits charged",
    downloadQuotePending: "Waiting for qualities",
    downloadStartBackground: "Start background download",
    viewDownloadTasks: "View tasks",
    downloadServiceOutdated: "The download service has not updated. Restart the Host and retry.",
    downloadResponseTooLarge: "Too many download options. Select fewer photos and retry.",
    downloadAuthFailed: "AFP authentication is unavailable. Check the account and retry.",
    downloadPhotoFailed: "This photo is unavailable. Refresh qualities to retry.",
    downloadNoRenditions: "No downloadable quality",
    downloadBalanceRequired: "The balance is unavailable. Refresh before selecting a paid quality.",
    downloadInsufficientCredit: "Insufficient credits. Choose another quality.",
    downloadPickerUnavailable: "This Host has no native folder picker.",
    downloadDirectoryExpired: "The destination expired. Choose a folder again.",
    downloadOptionsExpired: "The quality options expired. Refresh them.",
    downloadConfirmationExpired: "The confirmation expired. Review the download again.",
    downloadAccountChanged: "AFP account changed. Refresh the download options and confirm again.",
    downloadPaidDisabled: "Paid qualities require the remote write feature.",
    downloadOptionsFailed: "Could not read qualities. Retry or check the AFP account.",
    downloadDirectoryFailed: "Could not choose a destination. Retry and check folder permissions.",
    downloadPrepareFailed: "Could not review the download. Refresh qualities and retry.",
    downloadConfirmFailed: "Submission is not confirmed. Check task history before retrying.",
    cancelDownloadSetup: "Cancel",
    choosingDirectory: "Choosing\u2026",
    checkingDownload: "Checking\u2026",
    submittingDownload: "Submitting\u2026",
    downloadStartedNotice: "Background download started for {count} photos",
    viewDownloadProgress: "View download progress",
    downloadProgressTitle: "Background downloads",
    collapseDownloadProgress: "Collapse download progress",
    downloadProcessed: "Processed {count}/{total} photos",
    downloadCancelFailed: "Could not cancel the download. Try again.",
    bulkQualityTitle: "Set quality for all photos",
    bulkQualityFree: "Highest free quality",
    bulkQualityHighest: "Highest available quality",
    bulkQualityApplied: "Applied {count}/{total}",
    bulkQualityUnmatched: "Unmatched photos keep their current quality",
    selectAllCollection: "Select all",
    deselectCollection: "Deselect all",
    cancelSelectAll: "Cancel loading",
    selectAllFailed: "Unable to select all photos. Try again",
    downloadSelectionLimit: "Download up to 120 photos per batch; reduce your selection",
    openDownloadTasks: "Open download tasks",
    keywordSuggestions: "Suggested keywords",
    skillKeywords: "Skill keywords",
    suggestionCategories: "Keyword categories",
    noKeywordSuggestions: "No matching keywords. You can search your current text.",
    keywordSuggestionHint: "\u2191 \u2193 Select \xB7 Enter Fill \xB7 Enter again Search \xB7 Esc Close",
    addFavorites: "Add to collection",
    addFavoritesHelp: "Add this batch to a private collection while keeping existing memberships.",
    confirmAddFavorites: "Confirm addition",
    addingFavorites: "Adding photos",
    noMatchingCollections: "No matching collections",
    noWritableCollections: "No writable named private collections",
    favoritesPermissionsRequired: "Enable both read and write features",
    favoritesWriteUncertain: "The write result could not be retrieved. Check the target collection before retrying.",
    favoritesAdded: "{count} added",
    favoritesExisting: "{count} already present",
    favoritesCompleted: "{count} completed",
    favoritesFailed: "{count} failed",
    favoritesPending: "{count} unverified",
    favoritesPartialHelp: "Addition was not confirmed for the following photos. Check the target collection before taking further action.",
    favoritesPendingLabel: "Unverified",
    favoritesSelectionLimit: "Add at most 120 photos per batch. Reduce your selection.",
    loadMoreFailed: "The next page could not be loaded. Existing photos were kept.",
    paginationPaused: "No new photos or a repeated page cursor. Pagination is paused; you can search again."
  };

  // assets/workbench.css
  var workbench_default = ".afp-workbench { max-width: 1000px; margin: 0 auto; padding: 28px; overflow: auto; height: 100%; box-sizing: border-box; color: var(--dsw-alias-label-primary); font-size: 13px; }\n.afp-workbench h2 { font-size: 22px; margin: 0 0 8px; }\n.afp-workbench h3 { font-size: 15px; margin: 0 0 16px; }\n.afp-workbench h4 { font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 16px 0 8px; }\n.afp-header, .afp-line { display: flex; align-items: center; justify-content: space-between; gap: 20px; }\n.afp-section { margin-top: 26px; padding: 18px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px; background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 45%, transparent); backdrop-filter: blur(8px); }\n.afp-line { padding: 9px 0; }\n.afp-muted { color: var(--dsw-alias-label-secondary); margin: 6px 0; font-size: 12px; }\n.afp-toolbar, .afp-categories { display: flex; gap: 10px; flex-wrap: wrap; margin: 12px 0; align-items: center; }\n.afp-categories label { display: inline-flex; gap: 6px; align-items: center; }\n.afp-button, .afp-input { color: inherit; font: inherit; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); padding: 8px 12px; }\n.afp-button { cursor: pointer; }\n.afp-button:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-3); }\n.afp-button:disabled { cursor: default; opacity: .45; }\n.afp-input { min-width: 160px; flex: 1; }\n.afp-workbench :focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 3px; }\n.afp-configuration textarea:focus-visible, .afp-configuration summary:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }\n.afp-report { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 360px; overflow: auto; font-size: 12px; }\n.afp-error { color: var(--dsw-alias-state-error-primary); }\n.afp-confirm { border-color: var(--dsw-alias-state-business-primary); }\n.afp-deployment { display: grid; gap: 8px; margin-top: 20px; }\n.afp-deployment textarea { width: 100%; box-sizing: border-box; font-family: var(--ds-font-family-code); font-size: 12px; }\n.afp-configuration .afp-toolbar { align-items: flex-end; }\n.afp-configuration label { display: grid; gap: 6px; flex: 1; min-width: 0; }\n.afp-configuration { display: flex; flex-direction: column; block-size: min(430px, 65dvh); min-width: 0; min-height: 0; overflow: hidden; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.5; }\n.afp-configuration:not(.afp-wb-config-form) { container: afp-config-dialog / inline-size; }\n.afp-configuration[data-vision='true'] { block-size: min(510px, 65dvh); }\n[role='dialog']:has(.afp-configuration[data-vision='true']) { width: min(860px, 100%); }\n[role='dialog']:has(.afp-configuration:not(.afp-wb-config-form))::before { background: var(--dsw-alias-bg-layer-1); }\n.afp-config-scroll { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; padding-right: 4px; }\n.afp-config-columns { display: grid; gap: 24px; align-items: stretch; }\n.afp-configuration[data-vision='true'] .afp-config-columns { grid-template-columns: minmax(0, .8fr) minmax(0, 1.2fr); }\n.afp-config-section { min-width: 0; }\n.afp-form-heading { margin: 0 0 14px; color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; }\n.afp-form-field { display: grid; gap: 6px; min-width: 0; }\n.afp-form-label { display: flex; align-items: center; justify-content: space-between; gap: 8px; }\n.afp-configuration .afp-form-label > label { display: block; flex: none; }\n.afp-configuration .afp-form-field .afp-wb-input { box-sizing: border-box; min-width: 0; width: 100%; height: 36px; gap: 8px; padding: 0 10px; border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); transition: border-color 160ms ease, box-shadow 160ms ease; }\n.afp-configuration .afp-wb-input:hover:not(:has(input:disabled)) { border-color: var(--dsw-alias-label-tertiary); }\n.afp-configuration .afp-wb-input:focus-within { border-color: var(--dsw-alias-state-business-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent); }\n.afp-configuration .afp-wb-input > input { width: 0; padding: 0; }\n.afp-configuration .afp-wb-input > input::placeholder { color: var(--dsw-alias-label-tertiary); }\n.afp-configuration .afp-stored-mask > input::placeholder { color: var(--dsw-alias-label-secondary); letter-spacing: 2px; }\n.afp-configuration .afp-wb-input:has(input:disabled) { opacity: .65; background: var(--dsw-alias-bg-layer-2); }\n.afp-secret-control { position: relative; min-width: 0; }\n.afp-configuration .afp-secret-control > .afp-wb-input { width: 100%; padding-right: 38px; }\n.afp-configuration .afp-credential-visibility { position: absolute; top: 50%; right: 4px; width: 24px; height: 24px; min-height: 24px; padding: 0; transform: translateY(-50%); color: var(--dsw-alias-label-secondary); }\n.afp-credential-visibility:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }\n.afp-configuration .afp-credential-visibility:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }\n.afp-token-line { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin: 14px 0 0; flex-wrap: wrap; }\n.afp-token-state { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary); }\n.afp-credential-grid { display: grid; gap: 12px; }\n.afp-credential-field { display: flex; align-items: flex-end; gap: 10px; }\n.afp-credential-actions { display: flex; gap: 8px; align-items: center; flex: none; }\n.afp-credential-field small { margin-left: 8px; color: var(--dsw-alias-label-tertiary); font-size: 11px; overflow-wrap: anywhere; }\n.afp-config-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }\n.afp-config-fields > :first-child, .afp-config-fields > :nth-child(2) { grid-column: 1 / -1; }\n@container afp-config-dialog (max-width: 660px) { .afp-configuration[data-vision='true'] .afp-config-columns { grid-template-columns: minmax(0, 1fr); } }\n@container afp-config-dialog (max-width: 400px) { .afp-config-fields { grid-template-columns: minmax(0, 1fr); } }\n.afp-advanced { margin: 20px 0 12px; }\n.afp-advanced summary { cursor: pointer; color: var(--dsw-alias-label-secondary); }\n.afp-config-footer { flex: none; display: flex; justify-content: flex-end; padding-top: 14px; margin-top: 14px; border-top: 1px solid var(--dsw-alias-border-l3); }\n.afp-skeleton { display: block; background: var(--dsw-alias-bg-skeleton); border-radius: var(--dsw-radius-sm); animation: afp-skeleton-pulse 2s cubic-bezier(.36, 0, .64, 1) infinite; }\n.afp-skeleton-label { height: 20px; width: 100px; }\n.afp-skeleton-input { height: 32px; width: 100%; }\n.afp-skeleton-button { height: 32px; width: 84px; }\n@keyframes afp-skeleton-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }\n@media (prefers-reduced-motion: reduce) { .afp-skeleton { animation: none; } }\n@media (max-width: 760px) { .afp-configuration[data-vision='true'] .afp-config-columns { grid-template-columns: minmax(0, 1fr); } }\n.afp-workbench table { border-collapse: collapse; width: 100%; text-align: left; }\n.afp-workbench th, .afp-workbench td { padding: 8px; }\n.afp-workbench summary { cursor: pointer; padding: 10px 0; overflow-wrap: anywhere; }\n@media (max-width: 620px) { .afp-workbench { padding: 16px; } .afp-section { padding: 12px; } .afp-line { gap: 12px; } .afp-config-fields { grid-template-columns: minmax(0, 1fr); } }\n\n.afp-workbench.afp-wb-root { container-type: inline-size; display: flex; flex: 1; flex-direction: column; width: 100%; max-width: none; height: 100%; min-height: 0; overflow: hidden; margin: 0; padding: 20px 24px; background: var(--dsw-alias-bg-base); font-size: 13px; line-height: 1.5; }\n/* \u8BBE\u7F6E\u9875\u7684\u5185\u5BB9\u5BB9\u5668\u4E5F\u9700\u8981\u53C2\u4E0E\u9AD8\u5EA6\u5206\u914D\uFF0C\u5426\u5219\u5DE5\u4F5C\u53F0\u7684\u767E\u5206\u6BD4\u9AD8\u5EA6\u4F1A\u968F\u5185\u5BB9\u589E\u957F\u3002 */\n[data-settings-section='afp-workbench'] { display: flex; flex-direction: column; overflow: hidden; padding-top: calc(12px + var(--dsh-frame-top-clearance, 0px)); padding-bottom: 16px; }\n[data-settings-section='afp-workbench'] > div { display: flex; flex: 1; flex-direction: column; min-height: 0; max-width: none; }\n[data-settings-section='afp-workbench'] > div > footer { display: none; }\n[data-settings-section='afp-workbench'] .afp-workbench.afp-wb-root { padding-top: 8px; }\n.afp-wb-root, .afp-wb-root * { box-sizing: border-box; }\n.afp-wb-root [hidden] { display: none !important; }\n.afp-wb-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }\n.afp-wb-header { display: flex; flex: none; align-items: center; justify-content: space-between; gap: 16px; padding-bottom: 16px; }\n.afp-wb-brand, .afp-wb-header-actions, .afp-wb-actions { display: flex; align-items: center; gap: 10px; min-width: 0; }\n.afp-wb-brand { color: var(--dsw-alias-state-business-primary); }\n.afp-wb-brand > svg { flex: none; }\n.afp-wb-brand h1 { margin: 0; color: var(--dsw-alias-label-primary); font-size: 18px; font-weight: 500; white-space: nowrap; }\n.afp-wb-profile { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); font-size: 12px; }\n.afp-wb-tabstrip { display: flex; flex: none; align-items: stretch; gap: 0; min-height: 42px; padding: 6px 8px 0; overflow-x: auto; scrollbar-width: thin; background: var(--dsw-alias-bg-module-platform); border: 1px solid var(--dsw-alias-border-l2); border-bottom: 0; border-radius: 12px 12px 0 0; }\n.afp-wb-tab { position: relative; display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; gap: 7px; min-height: 36px; padding: 7px 14px 9px; border: 0; border-radius: 9px 9px 0 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; cursor: pointer; transition: background-color 140ms ease, color 140ms ease; white-space: nowrap; }\n.afp-wb-tab:not(.is-active)::after { position: absolute; right: 0; top: 10px; width: 1px; height: 16px; background: var(--dsw-alias-border-l2); content: ''; }\n.afp-wb-tab:not(.is-active):hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }\n.afp-wb-tab.is-active { z-index: 1; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-weight: 500; }\n.afp-wb-tab.is-active::before, .afp-wb-tab.is-active::after { position: absolute; bottom: 0; width: 9px; height: 9px; content: ''; pointer-events: none; }\n.afp-wb-tab.is-active::before { left: -9px; border-radius: 0 0 9px 0; box-shadow: 4px 4px 0 4px var(--dsw-alias-bg-base); }\n.afp-wb-tab.is-active::after { right: -9px; border-radius: 0 0 0 9px; box-shadow: -4px 4px 0 4px var(--dsw-alias-bg-base); }\n.afp-wb-tab:focus-visible { z-index: 2; outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: -3px; }\n.afp-wb-content { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; overflow: hidden; border: 1px solid var(--dsw-alias-border-l2); border-top: 0; border-radius: 0 0 12px 12px; background: var(--dsw-alias-bg-base); }\n/* \u6807\u7B7E\u9762\u677F\u5404\u81EA\u4FDD\u5B58\u6EDA\u52A8\u4F4D\u7F6E\uFF1B\u77ED\u5185\u5BB9\u4E5F\u53C2\u4E0E\u5269\u4F59\u9AD8\u5EA6\u5206\u914D\u3002 */\n.afp-wb-tabpanel { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; height: 100%; padding: 18px; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }\n.afp-wb-tabpanel:not([hidden]) { animation: afp-wb-panel-enter 180ms ease-out; }\n.afp-wb-panel-content { display: flex; flex-direction: column; flex: 1; min-width: 0; }\n@keyframes afp-wb-panel-enter { from { opacity: 0; } to { opacity: 1; } }\n@keyframes afp-wb-pane-enter { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }\n.afp-wb-section { min-width: 0; padding: 16px 0; border: 0; border-bottom: 1px solid var(--dsw-alias-border-l2); background: transparent; }\n.afp-wb-section:first-child { padding-top: 0; }\n.afp-wb-section:last-child { border-bottom: 0; }\n.afp-wb-root h2, .afp-wb-root h3, .afp-wb-root h4 { color: var(--dsw-alias-label-primary); font-weight: 500; }\n.afp-wb-root h3 { margin: 0; font-size: 14px; }\n.afp-wb-root h4 { margin: 10px 0 8px; font-size: 13px; }\n.afp-wb-subtle, .afp-wb-root .afp-muted { color: var(--dsw-alias-label-secondary); font-size: 12px; }\n.afp-wb-global-error, .afp-wb-error { color: var(--dsw-alias-state-error-primary); }\n.afp-wb-global-error { margin: 0 0 10px; font-size: 13px; }\n.afp-wb-error-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 10px 0; color: var(--dsw-alias-state-error-primary); font-size: 13px; }\n.afp-wb-search-toolbar { display: flex; align-items: center; gap: 10px; padding-bottom: 10px; }\n.afp-wb-search-layout { min-height: 0; gap: 8px; }\n.afp-wb-search-layout > .afp-wb-search-toolbar { flex: none; padding: 0 0 12px; border-bottom: 1px solid var(--dsw-alias-border-l2); }\n.afp-wb-search-layout > .afp-wb-gallery-layout { flex: 1; min-height: 0; align-content: start; }\n.afp-wb-search-layout > .afp-wb-empty-block { min-height: 180px; }\n.afp-wb-search-layout > .afp-wb-empty-block + .afp-wb-gallery-layout { flex: none; }\n.afp-wb-search-input { flex: 1 1 auto; min-width: 0; }\n.afp-wb-search-input-slot { flex: 1 1 auto; min-width: 0; }\n.afp-wb-search-input-slot > .afp-wb-search-input { width: 100%; }\n/* \u83DC\u5355\u901A\u8FC7\u9879\u76EE Portal \u6E32\u67D3\uFF0C\u72EC\u7ACB\u58F0\u660E\u5B57\u4F53\u4E0E\u4E3B\u9898\u989C\u8272\u3002 */\n.afp-wb-search-suggestions { z-index: 1100; display: flex; flex-direction: column; box-sizing: border-box; overflow: hidden; padding: 8px; color: var(--dsw-alias-label-primary); font: 13px/1.5 var(--dsw-font-family); }\n.afp-wb-suggestion-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 6px 8px; color: var(--dsw-alias-label-secondary); }\n.afp-wb-suggestion-categories { display: flex; flex: 0 0 auto; gap: 4px; overflow-x: auto; padding: 0 2px 8px; }\n.afp-wb-suggestion-categories > button { flex-shrink: 0; }\n.afp-wb-suggestion-list { min-height: 0; overflow-y: auto; overscroll-behavior: contain; }\n.afp-wb-suggestion-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 10px; border-radius: var(--dsw-radius-sm); cursor: pointer; }\n.afp-wb-suggestion-row.is-active { background: var(--dsw-alias-interactive-bg-hover); }\n.afp-wb-suggestion-row > div { display: flex; flex-wrap: wrap; gap: 3px 10px; min-width: 0; }\n.afp-wb-suggestion-term { overflow-wrap: anywhere; }\n.afp-wb-suggestion-aliases { color: var(--dsw-alias-label-tertiary); font-size: 12px; }\n.afp-wb-suggestion-row > span { flex-shrink: 0; }\n.afp-wb-suggestion-hint, .afp-wb-suggestion-empty { margin: 0; padding: 8px 6px 2px; color: var(--dsw-alias-label-tertiary); font-size: 12px; }\n.afp-wb-suggestion-hint { flex-shrink: 0; border-top: 1px solid var(--dsw-alias-border-l2); }\n.afp-wb-search-toolbar > button { flex: none; min-height: 36px; }\n.afp-wb-root .afp-wb-input { min-width: 0; width: 100%; height: 36px; padding: 0 10px; gap: 8px; border-radius: var(--dsw-radius-md); transition: border-color 160ms ease, box-shadow 160ms ease, background-color 160ms ease; }\n.afp-wb-root .afp-wb-input:hover:not(:has(input:disabled)) { border-color: var(--dsw-alias-label-tertiary); }\n.afp-wb-root .afp-wb-input:focus-within { border-color: var(--dsw-alias-state-business-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent); }\n/* \u539F\u751F Input \u5DF2\u5728\u5916\u5C42\u63D0\u4F9B\u7126\u70B9\u8FB9\u6846\uFF0C\u5185\u90E8\u4E0D\u80FD\u91CD\u590D\u7ED8\u5236\u5DE5\u4F5C\u53F0\u7684\u901A\u7528\u7126\u70B9\u73AF\u3002 */\n.afp-wb-root .afp-wb-input > input:focus-visible { outline: none; }\n.afp-wb-root .afp-wb-input > input { padding: 0; }\n.afp-wb-root .afp-wb-input > input::placeholder { color: var(--dsw-alias-label-tertiary); }\n.afp-wb-root .afp-wb-input:has(input:disabled) { opacity: .55; background: var(--dsw-alias-bg-module-platform); }\n.afp-wb-language { display: block; flex: none; }\n.afp-wb-field, .afp-wb-number-fields label, .afp-wb-toolbar label { display: grid; gap: 6px; min-width: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; }\n.afp-wb-selector { min-width: 0; }\n.afp-wb-selector > span { display: block; width: 100%; }\n.afp-wb-selector-trigger { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; min-height: 36px; font-weight: 400; }\n.afp-wb-selector-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.afp-wb-selector-trigger svg { flex: none; color: var(--dsw-alias-label-tertiary); }\n.afp-wb-root input[type='number'] { height: auto; padding: 0; border: 0; border-radius: 0; background: transparent; }\n.afp-wb-number-fields label > span { width: 100%; }\n.afp-wb-result-bar, .afp-wb-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }\n.afp-wb-result-bar { min-height: 32px; color: var(--dsw-alias-label-secondary); font-size: 12px; }\n.afp-wb-result-bar p { margin: 0; }\n.afp-wb-gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(180px, 100%), 1fr)); align-items: start; gap: 18px 14px; padding: 12px 0; }\n.afp-wb-photo-tile { min-width: 0; display: flex; flex-direction: column; gap: 6px; }\n.afp-wb-photo-frame { position: relative; width: 100%; aspect-ratio: 4 / 3; border-radius: 8px; outline: 1px solid transparent; outline-offset: 2px; cursor: pointer; transition: outline-color 140ms ease; }\n.afp-wb-photo-tile.is-selected .afp-wb-photo-frame { outline-color: var(--dsw-alias-state-business-primary); }\n.afp-wb-root .afp-wb-photo-select { position: absolute; top: 6px; right: 6px; z-index: 1; display: grid; place-items: center; width: 28px; min-width: 28px; height: 28px; padding: 0; border-radius: 50%; background: transparent; border: 0; opacity: 0; transition: opacity 160ms var(--ds-ease-in-out); }\n.afp-wb-photo-frame:hover .afp-wb-photo-select, .afp-wb-photo-frame:focus-within .afp-wb-photo-select { opacity: 1; }\n.afp-wb-root .afp-wb-photo-select.is-selected { opacity: 1; }\n.afp-wb-root .afp-wb-photo-select:hover, .afp-wb-root .afp-wb-photo-select:active { background: transparent; }\n.afp-wb-root .afp-wb-photo-select.is-selected:hover .afp-wb-photo-selected-icon { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 88%, var(--dsw-alias-label-primary)); }\n.afp-wb-root .afp-wb-photo-select:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 3px; }\n.afp-wb-photo-selected-icon, .afp-wb-photo-select-icon { display: grid; place-items: center; box-sizing: border-box; width: 20px; height: 20px; border-radius: 50%; pointer-events: none; box-shadow: var(--dsw-shadow-lv1); transition: background-color 160ms var(--ds-ease-in-out); }\n.afp-wb-photo-selected-icon { background: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-primary-foreground); }\n.afp-wb-photo-select-icon { background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l3); }\n@media (hover: none) { .afp-wb-root .afp-wb-photo-select { opacity: 1; } }\n.afp-wb-photo-open, .afp-wb-selection-open { display: grid; width: 100%; padding: 0; gap: 6px; border: 0; background: transparent; color: inherit; text-align: left; font: inherit; cursor: pointer; }\n.afp-wb-image-button { display: block; width: 100%; padding: 0; border: 0; border-radius: 8px; background: transparent; cursor: pointer; }\n.afp-wb-photo { display: block; width: 100%; aspect-ratio: auto; object-fit: contain; object-position: center; background: var(--dsw-alias-bg-module-platform); border-radius: 8px; }\n.afp-wb-photo-title, .afp-wb-photo-reason { display: -webkit-box; overflow: hidden; line-height: 1.5; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }\n.afp-wb-photo-title { min-height: 3em; color: var(--dsw-alias-label-primary); font-size: 13px; }\n.afp-wb-photo-open:hover { color: var(--dsw-alias-state-business-primary); }\n.afp-wb-photo-open:hover .afp-wb-photo-title { color: inherit; }\n.afp-wb-photo-tile p { margin: 0; }\n.afp-wb-photo-meta { display: flex; flex-wrap: wrap; gap: 4px 8px; min-width: 0; color: var(--dsw-alias-label-tertiary); font-size: 11px; }\n.afp-wb-photo-meta > span:first-child { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.afp-wb-photo-id { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.afp-wb-image-fallback { display: flex; min-width: 0; min-height: 100px; aspect-ratio: 4 / 3; flex-direction: column; align-items: center; justify-content: center; gap: 5px; padding: 8px; overflow-wrap: anywhere; background: var(--dsw-alias-bg-module-platform); border-radius: 8px; color: var(--dsw-alias-label-tertiary); font-size: 12px; text-align: center; }\n.afp-wb-photo-large { display: block; width: 100%; height: auto; max-height: 32vh; object-fit: contain; background: var(--dsw-alias-bg-module-platform); border-radius: 8px; }\n.afp-wb-image-fallback-large { min-height: 160px; aspect-ratio: auto; }\n.afp-wb-load-row { display: flex; justify-content: center; padding: 10px 0; }\n.afp-wb-account-skeleton { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; padding: 12px 0; }\n.afp-wb-skeleton-tile span { display: block; min-height: 14px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-skeleton); }\n.afp-wb-skeleton-tile span:first-child { width: 100%; aspect-ratio: 4 / 3; }\n.afp-wb-skeleton-tile span:nth-child(2) { width: 90%; height: 39px; }\n.afp-wb-skeleton-tile span:last-child { width: 40%; height: 1.5em; font-size: 11px; }\n.afp-wb-skeleton-tile { display: grid; gap: 6px; }\n.afp-wb-pagination-note { margin: 0; padding: 10px 0; color: var(--dsw-alias-label-secondary); font-size: 12px; text-align: center; }\n.afp-wb-visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }\n.afp-wb-empty { margin: 0; padding: 24px 8px; color: var(--dsw-alias-label-secondary); text-align: center; font-size: 12px; }\n.afp-wb-empty-block { display: grid; flex: 1; align-content: center; justify-items: center; gap: 12px; padding: 32px 12px; color: var(--dsw-alias-label-secondary); text-align: center; }\n.afp-wb-empty-block p { margin: 0; }\n.afp-wb-empty-icon { color: var(--dsw-alias-label-tertiary); }\n.afp-wb-gallery-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; align-items: stretch; min-width: 0; }\n.afp-wb-gallery-wrap { min-width: 0; }\n.afp-wb-detail { min-width: 0; overflow: hidden; padding: 14px 0; border-bottom: 1px solid var(--dsw-alias-border-l2); order: -1; animation: afp-wb-pane-enter 180ms ease-out; }\n.afp-wb-detail-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 10px; }\n.afp-wb-detail-title, .afp-wb-caption { overflow-wrap: anywhere; }\n.afp-wb-caption { white-space: pre-wrap; color: var(--dsw-alias-label-secondary); font-size: 13px; }\n.afp-wb-keywords { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }\n.afp-wb-selection { display: flex; flex-direction: column; box-sizing: border-box; min-height: 0; }\n.afp-wb-selection > .afp-wb-detail-head, .afp-wb-selection > button { flex: none; }\n.afp-wb-selection > button { align-self: flex-start; }\n.afp-wb-selection-list { display: grid; align-content: start; min-height: 0; gap: 10px; max-height: 48vh; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; padding-bottom: 10px; }\n.afp-wb-selection-item { display: grid; grid-template-columns: 62px minmax(0, 1fr) 28px; align-items: center; gap: 10px; padding: 6px; border-radius: var(--dsw-radius-md); transition: background-color 160ms var(--ds-ease-in-out); }\n.afp-wb-selection-item:hover, .afp-wb-selection-item:focus-within { background: var(--dsw-alias-interactive-bg-hover); }\n.afp-wb-root .afp-wb-selection-remove { display: grid; place-items: center; width: 28px; min-width: 28px; height: 28px; padding: 0; border-radius: var(--dsw-radius-sm); color: var(--dsw-alias-label-secondary); transition: opacity 160ms var(--ds-ease-in-out), background-color 160ms var(--ds-ease-in-out), color 160ms var(--ds-ease-in-out); }\n.afp-wb-root .afp-wb-selection-remove { opacity: 0; pointer-events: none; }\n.afp-wb-selection-item:hover .afp-wb-selection-remove, .afp-wb-selection-item:focus-within .afp-wb-selection-remove { opacity: 1; pointer-events: auto; }\n.afp-wb-root .afp-wb-selection-remove:hover { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, var(--dsw-alias-bg-base)); }\n.afp-wb-root .afp-wb-selection-remove:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }\n@media (hover: none) { .afp-wb-root .afp-wb-selection-remove { opacity: 1; pointer-events: auto; } }\n@media (pointer: coarse) {\n  .afp-wb-root .afp-wb-selection-remove, .afp-wb-root .afp-wb-photo-select { width: 44px; min-width: 44px; height: 44px; }\n  .afp-wb-selection-item { grid-template-columns: 62px minmax(0, 1fr) 44px; }\n}\n.afp-wb-selection-open { overflow: hidden; }\n.afp-wb-selection-item .afp-wb-photo, .afp-wb-selection-item .afp-wb-image-fallback { width: 62px; min-width: 62px; min-height: 42px; height: 42px; aspect-ratio: auto; object-fit: contain; }\n.afp-wb-selection-open > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }\n.afp-wb-collections-layout { display: grid; flex: 1; grid-template-columns: minmax(0, 1fr); gap: 16px; align-content: start; }\n.afp-wb-collection-sidebar { min-width: 0; padding-bottom: 14px; border-bottom: 1px solid var(--dsw-alias-border-l2); }\n.afp-wb-filter { flex: none; width: 100%; }\n.afp-wb-collection-list { position: relative; display: grid; align-content: start; gap: 2px; max-height: 260px; padding: 3px; overflow: auto; }\n.afp-wb-root .afp-wb-collection-item { position: relative; z-index: 1; display: flex; justify-content: flex-start; align-items: center; gap: 8px; width: 100%; height: auto; min-height: 36px; padding: 6px 8px; border: 0; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-secondary); text-align: left; font: inherit; cursor: pointer; transition: background-color 150ms var(--ds-ease-in-out), color 150ms var(--ds-ease-in-out); }\n.afp-wb-root .afp-wb-collection-item:hover, .afp-wb-root .afp-wb-collection-item.is-selected { background: var(--dsw-specific-sidebar-nav-item-hover); color: var(--dsw-alias-label-primary); }\n.afp-wb-root .afp-wb-collection-list[data-glide-active='true'] .afp-wb-collection-item:hover:not(.is-selected) { background: transparent; }\n.afp-wb-history-row:hover { background: var(--dsw-alias-bg-layer-2); }\n.afp-wb-collection-item > svg { flex: none; color: var(--dsw-alias-label-tertiary); }\n.afp-wb-collection-item.is-selected > svg { color: var(--dsw-alias-state-business-primary); }\n.afp-wb-collection-item:focus-visible, .afp-wb-photo-open:focus-visible, .afp-wb-collection-scroll:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }\n.afp-wb-collection-content { display: flex; flex-direction: column; min-width: 0; }\n.afp-wb-collection-content > .afp-wb-empty { display: grid; flex: 1; place-items: center; }\n.afp-wb-collection-content > .afp-wb-gallery-layout { margin-top: 8px; }\n.afp-wb-collection-content .afp-wb-section-heading p { margin: 4px 0 0; }\n.afp-wb-history-list, .afp-wb-live-list { display: grid; }\n.afp-wb-history-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px 12px; padding: 10px 8px; border: 0; border-bottom: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: transparent; color: inherit; text-align: left; font: inherit; cursor: pointer; transition: background-color 140ms ease; }\n.afp-wb-history-row > :last-child { grid-column: 1 / -1; }\n.afp-wb-history-title { margin: 0; color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }\n.afp-wb-live-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--dsw-alias-border-l2); }\n.afp-wb-task-layout { display: grid; flex: 1; align-content: start; gap: 0 24px; }\n.afp-wb-task-results { min-width: 0; }\n.afp-wb-task-setup > .afp-wb-section-heading { margin-bottom: 16px; }\n.afp-wb-prerequisite { display: grid; justify-items: start; gap: 10px; padding: 12px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); font-size: 12px; }\n.afp-wb-prerequisite p { margin: 0; }\n.afp-wb-field-error { margin: 0; color: var(--dsw-alias-state-error-primary); font-size: 12px; }\n.afp-wb-root .afp-wb-input:has(input[aria-invalid='true']) { border-color: var(--dsw-alias-state-error-primary); }\n.afp-wb-task-setup .afp-wb-categories, .afp-wb-change-form .afp-wb-categories { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; width: 100%; }\n.afp-wb-category-option { display: flex; align-items: center; min-width: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); transition: background-color 160ms ease, border-color 160ms ease; }\n.afp-wb-category-option:hover:not(:has(input:disabled)) { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-label-tertiary); }\n.afp-wb-category-option[data-selected='true'], .afp-wb-category-option[data-selected='true']:hover { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, var(--dsw-alias-border-l2)); background: var(--dsw-alias-state-business-tertiary); }\n.afp-wb-category-option > label { position: relative; box-sizing: border-box; width: 100%; min-width: 0; padding: 8px 10px; gap: 8px; font-size: 13px; line-height: 20px; }\n.afp-wb-category-option input[type='checkbox'] { appearance: none; flex: none; width: 16px; height: 16px; border: 1px solid var(--dsw-alias-label-tertiary); border-radius: var(--dsw-radius-xs); background: var(--dsw-alias-bg-layer-1); transition: background-color 160ms ease, border-color 160ms ease; }\n.afp-wb-category-option input[type='checkbox']:checked { border-color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-state-business-primary); }\n.afp-wb-category-option > label:has(input:checked)::after { content: ''; position: absolute; left: 15px; top: 50%; width: 4px; height: 8px; border: solid var(--dsw-static-neutral-00); border-width: 0 2px 2px 0; transform: translateY(-65%) rotate(45deg); pointer-events: none; }\n.afp-wb-category-option:has(input:focus-visible) { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }\n.afp-wb-category-option input[type='checkbox']:focus-visible { outline: none; }\n@media (forced-colors: active) {\n  .afp-wb-category-option input[type='checkbox'] { appearance: auto; }\n  .afp-wb-category-option > label::after { display: none; }\n}\n.afp-wb-task-setup .afp-wb-refresh-form button[type='submit'] { width: 100%; }\n.afp-wb-history-skeleton { display: grid; }\n.afp-wb-history-skeleton > div { display: grid; grid-template-columns: minmax(0, 1fr) 52px; gap: 10px; padding: 12px 8px; border-bottom: 1px solid var(--dsw-alias-border-l2); }\n.afp-wb-history-skeleton .afp-skeleton { height: 14px; }\n.afp-wb-history-skeleton .afp-skeleton:first-child { width: 65%; }\n.afp-wb-history-skeleton .afp-skeleton:last-child { grid-column: 1 / -1; width: 85%; height: 12px; }\n.afp-wb-icon-action { flex: none; }\n.afp-wb-refresh-form { display: grid; gap: 12px; margin-top: 12px; }\n.afp-wb-refresh-form fieldset, .afp-wb-change-form fieldset { display: grid; justify-items: start; gap: 14px; width: 100%; min-width: 0; margin: 0; padding: 0; border: 0; }\n.afp-wb-refresh-form legend, .afp-wb-change-form legend { margin-bottom: 8px; padding: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; }\n.afp-wb-categories { display: flex; flex-wrap: wrap; gap: 10px 14px; }\n.afp-wb-number-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; width: 100%; max-width: 440px; }\n.afp-wb-resume { margin-top: 18px; border-top: 1px solid var(--dsw-alias-border-l2); }\n.afp-wb-resume summary { color: var(--dsw-alias-label-secondary); font-size: 12px; }\n.afp-wb-resume-row { display: flex; align-items: center; gap: 8px; padding: 8px 0; }\n.afp-wb-resume-row > span { flex: 1; min-width: 0; }\n.afp-wb-resume-row > button { flex: none; }\n.afp-wb-resume[open] > .afp-wb-resume-row, .afp-wb-budget[open] > .afp-config-fields, .afp-wb-config-form .afp-advanced[open] > .afp-deployment, .afp-wb-plan-history[open] > .afp-wb-plan-results { animation: afp-wb-pane-enter 180ms ease-out; }\n.afp-wb-report-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 6px 12px; padding: 12px 0; }\n.afp-wb-report-summary p { margin: 0; padding: 8px 10px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); font-size: 12px; }\n.afp-wb-toolbar { display: flex; flex-wrap: wrap; gap: 10px; padding: 10px 0; }\n.afp-wb-change-form { display: grid; gap: 14px; }\n.afp-wb-change-layout { display: grid; gap: 0 24px; align-content: start; }\n.afp-wb-change-results { min-width: 0; }\n.afp-wb-change-results > .afp-wb-section:only-child { padding-top: 16px; }\n.afp-wb-change-fields { display: grid; grid-template-columns: minmax(0, 1fr) minmax(130px, .35fr); gap: 16px; }\n.afp-wb-change-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; width: 100%; padding-top: 4px; }\n.afp-wb-change-footer p { margin: 0; }\n.afp-wb-change-footer button { flex: none; }\n.afp-wb-plan.afp-wb-section { border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); padding: 16px; margin: 0 0 16px; }\n.afp-wb-warning { color: var(--dsw-alias-label-secondary); font-size: 12px; }\n.afp-wb-plan .afp-wb-actions { margin-top: 12px; flex-wrap: wrap; }\n.afp-wb-plan-list { display: grid; gap: 6px; margin: 10px 0; }\n.afp-wb-plan-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: center; gap: 6px; padding: 8px 0; border-bottom: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); font-size: 12px; overflow-wrap: anywhere; }\n.afp-wb-plan-row strong { color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; }\n.afp-wb-plan-history { padding: 10px 0; border-bottom: 1px solid var(--dsw-alias-border-l2); }\n.afp-wb-plan-history strong { font-weight: 500; }\n.afp-wb-plan-history summary { display: flex; align-items: center; gap: 12px; padding: 2px 0; list-style: none; }\n.afp-wb-plan-history summary::-webkit-details-marker { display: none; }\n.afp-wb-plan-chevron { flex: none; color: var(--dsw-alias-label-tertiary); transform: rotate(-90deg); transition: transform 140ms ease; }\n.afp-wb-plan-history[open] .afp-wb-plan-chevron { transform: rotate(0); }\n.afp-wb-plan-date { text-align: right; }\n.afp-wb-plan-history summary > .afp-wb-history-title { flex: 1; }\n.afp-wb-plan-history > p { overflow-wrap: anywhere; }\n.afp-wb-plan-history summary { border-radius: var(--dsw-radius-md); transition: background-color 140ms ease; }\n.afp-wb-plan-history summary:hover { background: var(--dsw-alias-bg-layer-2); }\n.afp-wb-plan-history summary:focus-visible, .afp-wb-history-row:focus-visible, .afp-wb-resume summary:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }\n.afp-wb-plan-results { display: grid; gap: 4px; padding-left: 18px; color: var(--dsw-alias-label-secondary); font-size: 12px; }\n.afp-wb-account-layout { display: grid; gap: 0; }\n.afp-wb-account-layout [role='tabpanel']:not([hidden]) { animation: afp-wb-panel-enter 180ms ease-out; }\n.afp-wb-account-nav { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; padding-bottom: 14px; margin-bottom: 18px; border-bottom: 1px solid var(--dsw-alias-border-l2); }\n.afp-wb-account-segments { max-width: 440px; min-width: 0; }\n.afp-wb-account-profile { white-space: nowrap; }\n.afp-wb-account-layout .afp-form-heading { margin-top: 0; }\n.afp-wb-budget { margin-top: 16px; }\n.afp-wb-budget summary { padding: 4px 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }\n.afp-wb-budget .afp-config-fields { padding-top: 12px; }\n.afp-wb-config-form .afp-budget-fields > * { grid-column: auto; }\n.afp-wb-definition-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 24px; margin: 10px 0 0; }\n.afp-wb-definition-list > div { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 12px; padding: 7px 0; }\n.afp-wb-definition-list dt { color: var(--dsw-alias-label-secondary); font-size: 12px; }\n.afp-wb-definition-list dd { margin: 0; text-align: right; overflow-wrap: anywhere; font-size: 12px; }\n.afp-wb-feature-groups { display: grid; gap: 24px; }\n.afp-wb-feature-group-heading { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }\n.afp-wb-feature-group-heading h4 { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; }\n.afp-wb-feature-grid { display: grid; grid-template-columns: minmax(0, 1fr); align-items: start; gap: 10px; }\n.afp-wb-feature-tile { min-width: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 12px; transition: border-color 140ms ease; }\n.afp-wb-feature-tile:focus-within { border-color: var(--dsw-alias-state-business-primary); }\n.afp-wb-feature-line { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; align-items: center; gap: 10px; }\n.afp-wb-feature-icon { display: flex; justify-content: center; align-items: center; width: 28px; height: 28px; color: var(--dsw-alias-state-business-primary); }\n.afp-wb-feature-artwork { display: block; width: 22px; height: 22px; background: currentColor; mask-size: contain; mask-repeat: no-repeat; mask-position: center; }\n.afp-wb-feature-artwork img { display: none; }\n.afp-wb-feature-identity { display: grid; gap: 3px; min-width: 0; }\n.afp-wb-feature-title { display: flex; align-items: center; gap: 5px; width: fit-content; max-width: 100%; padding: 0; border: 0; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-weight: 500; text-align: left; cursor: pointer; }\n.afp-wb-feature-title > span { overflow-wrap: anywhere; }\n.afp-wb-feature-title svg { flex: none; color: var(--dsw-alias-label-tertiary); transform: rotate(-90deg); transition: transform 160ms ease; }\n.afp-wb-feature-tile.is-expanded .afp-wb-feature-title svg { transform: rotate(0); }\n.afp-wb-feature-title:hover { color: var(--dsw-alias-state-business-primary); }\n.afp-wb-feature-status { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--dsw-alias-label-secondary); }\n.afp-wb-feature-status[data-state='running'] { color: var(--dsw-alias-state-success-primary); }\n.afp-wb-feature-dot { flex: none; width: 4px; height: 4px; border-radius: 50%; background: currentColor; }\n.afp-wb-feature-details { display: grid; grid-template-rows: 0fr; visibility: hidden; transition: grid-template-rows 180ms ease, visibility 180ms ease; }\n.afp-wb-feature-tile.is-expanded .afp-wb-feature-details { grid-template-rows: 1fr; visibility: visible; }\n.afp-wb-feature-details-inner { min-height: 0; overflow: hidden; }\n.afp-wb-feature-details p { margin: 0; padding-top: 10px; color: var(--dsw-alias-label-secondary); font-size: 12px; overflow-wrap: anywhere; }\n.afp-wb-config-section > h3 { margin-bottom: 12px; }\n.afp-configuration.afp-wb-config-form, .afp-configuration.afp-wb-config-form[data-vision='true'] { block-size: auto; height: auto; min-height: 0; overflow: visible; }\n.afp-configuration.afp-wb-config-form[data-sectioned='true'] { max-width: 680px; }\n.afp-wb-config-form .afp-config-scroll { display: flex; flex-direction: column; overflow: visible; padding: 0; }\n.afp-configuration.afp-wb-config-form[data-vision='true'] .afp-config-columns { grid-template-columns: minmax(0, 1fr); gap: 0; }\n.afp-wb-config-form .afp-config-fields:not(.afp-budget-fields) { grid-template-columns: minmax(0, 1fr); }\n.afp-wb-config-form .afp-config-section:not([hidden]) { padding: 16px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); }\n.afp-wb-config-form .afp-form-heading { margin-bottom: 14px; }\n.afp-wb-config-form .afp-advanced { margin: 16px 0 0; }\n.afp-wb-config-form .afp-advanced > summary { width: fit-content; margin-inline-start: auto; padding: 4px 0; }\n.afp-wb-config-form .afp-config-footer { margin-top: 12px; padding-top: 12px; }\n.afp-configuration.afp-wb-config-form[data-section='vision'] { max-width: none; }\n.afp-wb-config-form .afp-config-layout { display: grid; flex: 1; grid-template-columns: minmax(0, 1fr); gap: 24px; align-items: stretch; }\n.afp-wb-config-form .afp-config-primary { display: flex; flex-direction: column; min-width: 0; }\n.afp-wb-config-form .afp-config-primary > .afp-config-columns { flex: 1; align-content: start; }\n.afp-wb-config-form[data-section='vision'] .afp-config-primary, .afp-wb-config-form .afp-config-advanced-card { box-sizing: border-box; padding: 16px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); }\n.afp-wb-config-form[data-section='vision'] .afp-config-section:not([hidden]) { padding: 0; border: 0; border-radius: 0; }\n.afp-wb-config-form[data-section='vision'] .afp-config-primary > .afp-config-footer { margin-top: 16px; }\n.afp-wb-config-form .afp-config-advanced-card:not([hidden]) { display: flex; flex-direction: column; min-width: 0; }\n.afp-wb-config-form .afp-advanced-toggle { display: flex; flex: none; align-items: center; justify-content: space-between; width: 100%; min-height: 28px; gap: 12px; padding: 0 4px; color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; text-align: start; }\n.afp-wb-config-form .afp-advanced-toggle svg { flex: none; color: var(--dsw-alias-label-secondary); transition: transform 160ms ease; }\n.afp-wb-config-form .afp-advanced-toggle[aria-expanded='false'] svg { transform: rotate(-90deg); }\n.afp-wb-config-form .afp-advanced-content:not([hidden]) { display: flex; flex: 1; flex-direction: column; min-width: 0; gap: 12px; margin-top: 14px; }\n.afp-wb-config-form .afp-advanced-content > .afp-muted { margin: 0; }\n.afp-wb-config-form .afp-advanced-content > .afp-deployment { display: flex; flex: 1; flex-direction: column; margin: 0; }\n.afp-wb-config-form .afp-advanced-content textarea { flex: 1; min-width: 0; min-height: 240px; max-width: 100%; resize: vertical; }\n.afp-wb-config-form .afp-advanced-skeleton { flex: 1; min-height: 240px; }\n.afp-wb-close-button { display: grid; place-items: center; flex: none; width: 28px; min-width: 28px; height: 28px; min-height: 28px; padding: 0; border-radius: var(--dsw-radius-sm); color: var(--dsw-alias-label-secondary); transition: color var(--ds-transition-duration) var(--ds-ease-in-out), background-color var(--ds-transition-duration) var(--ds-ease-in-out); }\n.afp-wb-close-button:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }\n.afp-wb-close-button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }\n.afp-wb-select-all { flex: none; gap: 6px; white-space: nowrap; }\n.afp-wb-select-all[aria-pressed='true'] { color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-state-business-tertiary); }\n@container (min-width: 680px) {\n  .afp-wb-panel-collections { overflow: hidden; }\n  .afp-wb-collections-layout { min-height: 0; grid-template-columns: 190px minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); align-content: stretch; gap: 18px; }\n  .afp-wb-collection-sidebar { display: flex; flex-direction: column; min-height: 0; padding: 0 14px 0 0; border-bottom: 0; border-right: 1px solid var(--dsw-alias-border-l2); }\n  .afp-wb-collection-list { flex: 1; min-height: 0; max-height: none; overscroll-behavior: contain; scrollbar-gutter: stable; }\n  .afp-wb-collection-content { min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }\n  .afp-wb-feature-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }\n}\n@container (min-width: 860px) {\n  .afp-wb-panel-search, .afp-wb-panel-changes { overflow: hidden; }\n  .afp-wb-search-layout > .afp-wb-gallery-layout { grid-template-rows: minmax(0, 1fr); overflow: hidden; align-content: stretch; }\n  .afp-wb-search-layout .afp-wb-gallery-wrap, .afp-wb-search-layout .afp-wb-detail { min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }\n  .afp-wb-panel-tasks { overflow: hidden; }\n  .afp-wb-task-layout, .afp-wb-change-layout { min-height: 0; grid-template-columns: 300px minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); align-content: stretch; align-items: stretch; }\n  .afp-wb-task-layout > .afp-wb-section { min-height: 0; overflow: auto; overscroll-behavior: contain; border-bottom: 0; padding: 0 4px 0 0; }\n  .afp-wb-task-results, .afp-wb-change-results { min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; border-left: 1px solid var(--dsw-alias-border-l2); padding-left: 24px; }\n  .afp-wb-change-layout > .afp-wb-change-form { display: flex; flex-direction: column; min-height: 0; overflow: auto; overscroll-behavior: contain; border-bottom: 0; padding: 0 4px 0 0; }\n  .afp-wb-change-fields { grid-template-columns: minmax(0, 1fr); gap: 12px; }\n  .afp-wb-change-footer { flex-direction: column; align-items: stretch; gap: 12px; }\n  .afp-wb-change-footer > button { width: 100%; }\n  .afp-wb-change-results > .afp-wb-section:only-child { padding-top: 0; }\n  .afp-wb-account-body:not(.is-credentials) .afp-config-fields:not(.afp-budget-fields) { grid-template-columns: repeat(2, minmax(0, 1fr)); }\n  .afp-wb-account-body:not(.is-credentials) .afp-config-fields:not(.afp-budget-fields) > :first-child { grid-column: 1 / -1; }\n  .afp-wb-gallery-layout { grid-template-columns: minmax(0, 1fr) 0px; gap: 0; transition: grid-template-columns 200ms ease, gap 200ms ease; }\n  .afp-wb-gallery-layout.is-with-aside { grid-template-columns: minmax(0, 1fr) 260px; gap: 18px; }\n  .afp-wb-detail { order: 0; padding: 0 0 0 16px; border-bottom: 0; border-left: 1px solid var(--dsw-alias-border-l2); }\n  .afp-wb-feature-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }\n  .afp-wb-plan-row { grid-template-columns: minmax(90px, .8fr) minmax(140px, 1.3fr) repeat(3, minmax(70px, .7fr)); }\n}\n@container (max-width: 500px) {\n  .afp-wb-tabpanel { padding: 14px; }\n  .afp-wb-search-toolbar { flex-wrap: wrap; }\n  .afp-wb-search-input, .afp-wb-search-input-slot { flex-basis: 100%; }\n  .afp-wb-language { flex: 1; }\n  .afp-wb-change-fields { grid-template-columns: minmax(0, 1fr); gap: 12px; }\n  .afp-wb-change-footer { align-items: flex-start; flex-direction: column; gap: 10px; }\n  .afp-wb-account-segments { width: 100%; font-size: 12px; }\n  .afp-wb-plan-history summary { flex-wrap: wrap; gap: 8px; }\n  .afp-wb-plan-date { order: 1; width: 100%; text-align: left; }\n  .afp-wb-definition-list { grid-template-columns: minmax(0, 1fr); }\n  .afp-wb-gallery { grid-template-columns: repeat(auto-fill, minmax(min(150px, 100%), 1fr)); gap: 14px 10px; }\n  .afp-wb-resume-row { flex-wrap: wrap; }\n  .afp-wb-resume-row > span { flex-basis: 100%; }\n  .afp-wb-header-actions { gap: 6px; }\n  .afp-wb-profile { display: none; }\n}\n@media (max-width: 620px) { .afp-workbench.afp-wb-root { padding: 16px 12px; } }\n@media (pointer: coarse) {\n  .afp-wb-root button, .afp-wb-root summary { min-height: 44px; }\n  .afp-wb-root input:not([type='checkbox']) { font-size: 16px; }\n}\n@media (prefers-reduced-motion: reduce) {\n  .afp-wb-root *, .afp-wb-root *::before, .afp-wb-root *::after { animation: none !important; transition: none !important; }\n}\n\n/* \u6536\u85CF\u5939\u6807\u9898\u56FA\u5B9A\uFF0C\u56FE\u7247\u5217\u8868\u548C\u8BE6\u60C5\u5206\u522B\u6D88\u8D39\u5269\u4F59\u9AD8\u5EA6\u3002 */\n.afp-wb-panel-collections { overflow: hidden; }\n.afp-wb-collections-layout { min-height: 0; grid-template-areas: 'controls' 'sidebar' 'content'; grid-template-rows: auto minmax(0, 170px) minmax(0, 1fr); align-content: stretch; transition: grid-template-columns 200ms ease, grid-template-rows 200ms ease, gap 200ms ease; }\n.afp-wb-collection-controls { grid-area: controls; display: flex; align-items: center; gap: 8px; min-width: 0; }\n.afp-wb-collection-filter-slot { flex: 1; min-width: 0; }\n.afp-wb-root .afp-wb-sidebar-toggle { flex: none; width: 36px; height: 36px; padding: 0; color: var(--dsw-alias-label-secondary); }\n.afp-wb-collection-sidebar { grid-area: sidebar; display: flex; flex-direction: column; min-height: 0; overflow: hidden; transition: opacity 160ms ease, visibility 200ms; }\n.afp-wb-collection-list { flex: 1; min-height: 0; max-height: none; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }\n.afp-wb-collections-layout.is-sidebar-collapsed { grid-template-rows: auto 0px minmax(0, 1fr); row-gap: 8px; }\n.afp-wb-collections-layout.is-sidebar-collapsed .afp-wb-collection-sidebar { opacity: 0; visibility: hidden; padding: 0; border: 0; }\n.afp-wb-collection-content { grid-area: content; min-height: 0; overflow: hidden; }\n.afp-wb-collection-heading { flex: none; gap: 12px; margin-bottom: 12px; }\n.afp-wb-collection-heading-left { display: flex; align-items: center; gap: 8px; min-width: 0; }\n.afp-wb-collection-heading-left h3 { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.afp-wb-collection-selection { display: flex; align-items: center; justify-content: flex-end; gap: 8px; min-width: 0; }\n.afp-wb-root .afp-wb-selection-summary { display: inline-flex; flex: none; align-items: center; gap: 8px; height: 38px; padding: 4px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-base); transition: background-color 160ms var(--ds-ease-in-out), border-color 160ms var(--ds-ease-in-out); }\n.afp-wb-root .afp-wb-selection-summary:hover, .afp-wb-root .afp-wb-selection-summary[aria-expanded='true'] { background: var(--dsw-alias-interactive-bg-hover); border-color: var(--dsw-alias-state-business-primary); }\n.afp-wb-root .afp-wb-selection-summary:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }\n.afp-wb-selection-thumbnails { display: flex; align-items: center; gap: 3px; }\n.afp-wb-selection-thumbnail, .afp-wb-selection-overflow { display: grid; place-items: center; flex: none; width: 28px; height: 28px; overflow: hidden; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); font-size: 10px; }\n.afp-wb-selection-thumbnail .afp-wb-preview-container, .afp-wb-selection-thumbnail .afp-wb-image-stage { width: 100%; height: 100%; min-height: 0; aspect-ratio: auto; }\n.afp-wb-selection-thumbnail .afp-wb-photo { width: 100%; height: 100%; object-fit: contain; }\n.afp-wb-selection-thumbnail .afp-wb-image-fallback { min-height: 0; width: 100%; height: 100%; aspect-ratio: auto; padding: 0; font-size: 0; }\n.afp-wb-selection-overflow { background: var(--dsw-alias-bg-layer-2); font-variant-numeric: tabular-nums; }\n.afp-wb-selection-count { min-width: 24px; justify-content: center; font-variant-numeric: tabular-nums; }\n.afp-wb-selection-label { color: var(--dsw-alias-label-secondary); font-size: 12px; white-space: nowrap; }\n.afp-wb-selection-chevron { flex: none; color: var(--dsw-alias-label-tertiary); transition: transform 160ms var(--ds-ease-in-out); }\n.afp-wb-selection-summary[aria-expanded='true'] .afp-wb-selection-chevron { transform: rotate(180deg); }\n@container (max-width: 620px) {\n  .afp-wb-collection-heading { flex-wrap: wrap; }\n  .afp-wb-collection-selection { justify-content: flex-start; flex-wrap: wrap; }\n  .afp-wb-selection-label { display: none; }\n}\n.afp-wb-collection-actions { display: flex; align-items: center; gap: 2px; }\n.afp-wb-root .afp-wb-collection-action { width: 32px; min-width: 32px; height: 32px; padding: 0; color: var(--dsw-alias-label-secondary); }\n.afp-wb-root .afp-wb-collection-action:not(:disabled):hover { color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-interactive-bg-hover); }\n.afp-wb-root .afp-wb-collection-action:focus-visible, .afp-wb-root .afp-wb-sidebar-toggle:focus-visible, .afp-wb-root .afp-wb-back-top:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }\n.afp-wb-collection-directory-heading { display: flex; flex: none; align-items: center; gap: 8px; padding: 0 10px 6px; color: var(--dsw-alias-label-tertiary); font-size: 11px; }\n.afp-wb-collection-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.afp-wb-collection-count { flex: none; font-size: 11px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }\n.afp-wb-collection-item.is-selected .afp-wb-collection-name { font-weight: 500; }\n.afp-wb-collection-glide { position: absolute; z-index: 0; opacity: 0; pointer-events: none; border-radius: var(--dsw-radius-sm); background: var(--dsw-specific-sidebar-nav-item-hover); transition: opacity 150ms var(--ds-ease-in-out); }\n.afp-wb-collection-glide[data-glide-placed='true'] { transition: top 220ms var(--ds-ease-in-out), left 220ms var(--ds-ease-in-out), width 220ms var(--ds-ease-in-out), height 220ms var(--ds-ease-in-out), opacity 150ms var(--ds-ease-in-out); }\n.afp-wb-collection-skeleton { display: grid; gap: 8px; overflow: hidden; }\n.afp-wb-collection-skeleton > span { height: 36px; flex: none; }\n.afp-wb-collection-stage { position: relative; flex: 1; min-height: 0; }\n.afp-wb-collection-stage > .afp-wb-gallery-layout { height: 100%; min-height: 0; grid-template-rows: minmax(0, 1fr); gap: 0; }\n.afp-wb-collection-stage > .afp-wb-gallery-layout.is-with-aside { grid-template-rows: minmax(0, 1fr) minmax(0, .7fr); gap: 12px; }\n.afp-wb-collection-scroll { min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; padding: 3px 4px 40px 3px; }\n.afp-wb-collection-stage .afp-wb-detail { min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; order: 0; border-bottom: 0; border-top: 1px solid var(--dsw-alias-border-l2); }\n.afp-wb-back-top { position: absolute; right: 12px; bottom: 12px; z-index: 2; width: 36px; height: 36px; padding: 0; border-radius: 50%; background: var(--dsw-alias-bg-base); box-shadow: var(--dsw-shadow-lv1); animation: afp-wb-pane-enter 180ms ease-out; transition: background-color 140ms ease, color 140ms ease, transform 140ms ease; }\n.afp-wb-back-top:hover { color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-interactive-bg-hover); transform: translateY(-1px); }\n.afp-wb-gallery-layout.is-with-aside + .afp-wb-back-top { bottom: calc(41% + 12px); }\n.afp-wb-photo-tile { padding: 6px; border: 1px solid transparent; border-radius: 10px; transition: border-color 160ms ease, background-color 160ms ease; }\n.afp-wb-photo-tile:hover { background: var(--dsw-alias-bg-module-platform); }\n.afp-wb-photo-tile.is-selected { background: transparent; }\n.afp-wb-photo-tile.is-selected .afp-wb-photo-frame { outline-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 35%, transparent); }\n.afp-wb-image-stage { position: relative; width: 100%; aspect-ratio: 4 / 3; overflow: hidden; border-radius: 8px; background: var(--dsw-alias-bg-module-platform); }\n.afp-wb-image-stage > img { width: 100%; height: 100%; opacity: 0; transition: opacity 200ms ease; }\n.afp-wb-image-stage.is-ready > img { opacity: 1; }\n/* \u7EDF\u4E00\u753B\u6846\u9AD8\u5EA6\uFF1B\u9884\u89C8\u3001\u9AA8\u67B6\u548C\u9519\u8BEF\u5360\u4F4D\u5171\u7528\u753B\u5E45\uFF0C\u56FE\u7247\u4FDD\u6301\u539F\u6BD4\u4F8B\u5B8C\u6574\u663E\u793A\u3002 */\n.afp-wb-photo-frame > .afp-wb-preview-container, .afp-wb-photo-frame .afp-wb-image-button, .afp-wb-photo-frame .afp-wb-image-stage, .afp-wb-photo-frame .afp-wb-image-fallback { width: 100%; height: 100%; min-height: 0; aspect-ratio: auto; }\n.afp-wb-photo-frame > .afp-wb-preview-container { position: absolute; inset: 0; }\n.afp-wb-photo-frame .afp-wb-image-fallback { box-sizing: border-box; }\n.afp-wb-photo-frame .afp-wb-image-stage > img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }\n.afp-wb-image-skeleton { position: absolute; inset: 0; width: 100%; height: 100%; }\n.afp-wb-image-stage.is-large { max-height: 32vh; }\n.afp-wb-preview-diagnostic { max-width: 100%; color: var(--dsw-alias-label-secondary); font-size: 11px; }\n.afp-wb-skeleton-tile span { animation: afp-skeleton-pulse 2s ease-in-out infinite; }\n.afp-wb-photo-identifiers { margin: 8px 0; color: var(--dsw-alias-label-secondary); font-size: 12px; }\n.afp-wb-photo-identifiers summary { padding: 6px 0; }\n.afp-wb-photo-identifiers dl { margin: 4px 0; }\n.afp-wb-photo-identifiers dt { margin-top: 8px; color: var(--dsw-alias-label-tertiary); }\n.afp-wb-photo-identifiers dd { margin: 2px 0; overflow-wrap: anywhere; user-select: text; }\n.afp-wb-detail-skeleton { display: grid; gap: 8px; margin-top: 12px; }\n.afp-wb-detail-skeleton span { height: 16px; }\n.afp-wb-detail-skeleton span:last-child { width: 65%; }\n.afp-wb-selection-item .afp-wb-image-stage { width: 62px; height: 42px; aspect-ratio: auto; }\n.afp-wb-preview-modal { width: min(1000px, 100%); max-height: 100%; color: var(--dsw-alias-label-primary); }\n.afp-wb-preview-modal-content { min-height: 0; overflow: auto; }\n.afp-wb-preview-modal .afp-wb-image-stage.is-large { height: min(70dvh, 720px); max-height: none; aspect-ratio: auto; }\n.afp-wb-preview-modal .afp-wb-photo-large { max-height: 100%; }\n.afp-wb-preview-modal .afp-wb-image-fallback-large { min-height: min(50dvh, 400px); }\n.afp-wb-account-body { display: grid; min-width: 0; gap: 24px; }\n.afp-wb-profile-slot { min-width: 0; }\n.afp-wb-account-body.is-credentials > .afp-wb-config-form { padding: 16px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); }\n.afp-wb-account-body.is-credentials .afp-config-section:not([hidden]) { padding: 0; border: 0; border-radius: 0; }\n.afp-wb-user-profile { box-sizing: border-box; min-width: 0; width: 100%; padding: 16px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); }\n.afp-wb-user-profile .afp-wb-section-heading { margin-bottom: 16px; }\n.afp-wb-user-identity { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }\n.afp-wb-user-avatar { display: grid; place-items: center; flex: none; width: 40px; height: 40px; border-radius: 50%; color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-state-business-tertiary); font-size: 18px; }\n.afp-wb-user-identity h4, .afp-wb-user-identity p { margin: 0; overflow-wrap: anywhere; }\n.afp-wb-user-identity p { margin-top: 3px; color: var(--dsw-alias-label-secondary); font-size: 12px; }\n.afp-wb-user-credit { display: grid; gap: 4px; padding: 14px 0; border-top: 1px solid var(--dsw-alias-border-l2); border-bottom: 1px solid var(--dsw-alias-border-l2); }\n.afp-wb-user-credit > span { color: var(--dsw-alias-label-secondary); font-size: 12px; }\n.afp-wb-user-credit strong { font-size: 24px; font-weight: 500; font-variant-numeric: tabular-nums; }\n.afp-wb-user-fields { display: grid; gap: 12px; margin: 18px 0; }\n.afp-wb-user-fields > div { display: grid; gap: 3px; }\n.afp-wb-user-fields dt { color: var(--dsw-alias-label-secondary); font-size: 12px; }\n.afp-wb-user-fields dd { margin: 0; overflow-wrap: anywhere; user-select: text; }\n.afp-wb-profile-skeleton { display: grid; gap: 16px; }\n.afp-wb-profile-skeleton span { height: 24px; }\n.afp-wb-profile-skeleton span:nth-child(2) { height: 70px; }\n.afp-wb-profile-error { color: var(--dsw-alias-label-secondary); font-size: 12px; }\n@container (min-width: 680px) {\n  .afp-wb-collections-layout { grid-template-areas: 'controls content' 'sidebar content'; grid-template-columns: 224px minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); column-gap: 16px; row-gap: 10px; }\n  .afp-wb-collection-sidebar { padding: 0; border: 0; }\n  .afp-wb-collection-content { padding-left: 16px; border-left: 1px solid var(--dsw-alias-border-l2); }\n  .afp-wb-collections-layout.is-sidebar-collapsed { grid-template-columns: 36px minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }\n}\n@container (min-width: 860px) {\n  .afp-wb-collection-stage > .afp-wb-gallery-layout, .afp-wb-collection-stage > .afp-wb-gallery-layout.is-with-aside { grid-template-rows: minmax(0, 1fr); }\n  .afp-wb-collection-stage .afp-wb-detail { padding-top: 0; border-top: 0; }\n  /* \u6E05\u5355\u586B\u6EE1\u753B\u5ECA\u5269\u4F59\u9AD8\u5EA6\uFF1B\u6EDA\u52A8\u53EA\u53D1\u751F\u5728\u5217\u8868\u4E2D\uFF0C\u6807\u9898\u4E0E\u6E05\u7A7A\u6309\u94AE\u4FDD\u7559\u53EF\u89C1\u3002 */\n  .afp-wb-search-layout .afp-wb-selection, .afp-wb-collection-stage .afp-wb-selection { height: 100%; align-self: stretch; overflow: hidden; scrollbar-gutter: auto; }\n  .afp-wb-selection-list { flex: 1; max-height: none; }\n  .afp-wb-gallery-layout.is-with-aside + .afp-wb-back-top { right: 292px; bottom: 12px; }\n  .afp-wb-account-body.is-credentials { grid-template-columns: minmax(0, 1.5fr) minmax(240px, .8fr); align-items: stretch; }\n  .afp-wb-config-form[data-section='vision'] .afp-config-layout { grid-template-columns: minmax(0, 1.5fr) minmax(240px, .8fr); }\n  .afp-wb-account-body.is-credentials > .afp-wb-profile-slot:not([hidden]) { display: flex; }\n}\n@media (prefers-reduced-motion: reduce) {\n  .afp-wb-root *, .afp-wb-preview-modal * { animation: none !important; transition: none !important; }\n}\n\n.afp-wb-action-modal { width: min(700px, calc(100vw - 32px)); max-height: min(86dvh, 880px); }\n.afp-wb-download-modal { --dsw-specific-menu: var(--dsw-alias-bg-layer-1); width: min(960px, 100%); height: 100%; max-height: 100%; gap: 0; padding: 0; }\n.afp-wb-download-header { display: flex; flex: none; align-items: center; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--dsw-alias-border-l2); }\n.afp-wb-download-heading-icon { display: grid; place-items: center; flex: none; width: 36px; height: 36px; color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-state-business-tertiary); border-radius: var(--dsw-radius-sm); }\n.afp-wb-download-header > div { flex: 1; min-width: 0; }\n.afp-wb-download-header h2 { margin: 0; color: var(--dsw-alias-label-primary); font-size: 16px; font-weight: 500; line-height: 24px; }\n.afp-wb-download-header p { margin: 3px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }\n.afp-wb-download-close { flex: none; width: 28px; height: 28px; padding: 0; }\n.afp-wb-download-scroll { display: grid; flex: 1; grid-template-columns: minmax(0, 1fr) 290px; min-height: 0; overflow: hidden; }\n.afp-wb-download-quality-section { container: afp-download-list / inline-size; display: flex; flex-direction: column; min-width: 0; min-height: 0; gap: 12px; padding: 16px 20px; }\n.afp-wb-download-settings { display: flex; flex-direction: column; min-width: 0; min-height: 0; gap: 16px; padding: 20px; overflow: auto; overscroll-behavior: contain; border-left: 1px solid var(--dsw-alias-border-l2); }\n.afp-wb-download-section-title { display: flex; align-items: center; justify-content: space-between; min-height: 28px; gap: 8px; }\n.afp-wb-download-section-title h3 { margin: 0; color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; }\n.afp-wb-download-section-label { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; min-width: 0; }\n.afp-wb-download-toolbar-actions { display: flex; flex: none; align-items: center; gap: 4px; }\n.afp-wb-download-modal .afp-wb-download-toolbar-button { width: 32px; min-width: 32px; height: 32px; padding: 0; color: var(--dsw-alias-label-secondary); }\n.afp-wb-download-toolbar-button[aria-expanded='true'] { background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-primary); }\n.afp-wb-download-toolbar-button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }\n.afp-wb-download-bulk-choice { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-width: min(240px, calc(100vw - 48px)); max-width: 320px; }\n.afp-wb-download-bulk-choice > span:first-child { flex: 1; min-width: 0; white-space: normal; overflow-wrap: anywhere; }\n.afp-wb-download-bulk-result { display: inline-flex; }\n.afp-wb-download-items { flex: 1; min-height: 0; padding-right: 4px; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }\n.afp-wb-download-item { display: grid; grid-template-columns: 80px minmax(0, 1fr); align-items: start; gap: 8px 14px; min-width: 0; padding: 12px 10px; border-bottom: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); transition: background-color var(--ds-transition-duration) var(--ds-ease-in-out); animation: afpDownloadReveal var(--ds-transition-duration) var(--ds-ease-in-out); }\n.afp-wb-download-item:hover, .afp-wb-download-item:focus-within { background: var(--dsw-alias-bg-layer-2); }\n.afp-wb-download-item:last-child { border-bottom: 0; }\n.afp-wb-download-thumbnail { grid-row: span 2; width: 80px; height: 60px; overflow: hidden; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-2); }\n.afp-wb-download-thumbnail .afp-wb-preview-container, .afp-wb-download-thumbnail .afp-wb-image-stage, .afp-wb-download-thumbnail .afp-wb-image-fallback { width: 100%; height: 100%; min-height: 0; aspect-ratio: auto; }\n.afp-wb-download-thumbnail .afp-wb-photo { width: 100%; height: 100%; object-fit: cover; }\n.afp-wb-download-thumbnail .afp-wb-image-fallback > span { display: none; }\n.afp-wb-download-thumbnail .afp-wb-image-fallback > span:first-child { display: block; font-size: 16px; }\n.afp-wb-download-item-name { display: grid; min-width: 0; gap: 6px; }\n.afp-wb-download-item-title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 19px; }\n.afp-wb-download-item-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; color: var(--dsw-alias-label-secondary); font-size: 11px; font-variant-numeric: tabular-nums; }\n.afp-wb-download-item-quality { grid-column: 2; display: flex; align-items: center; min-width: 0; gap: 6px; }\n.afp-wb-download-item-quality > :first-child { flex: 1; min-width: 0; }\n.afp-wb-download-item-quality .afp-wb-selector-trigger { min-height: 32px; height: 32px; border-radius: var(--dsw-radius-sm); font-size: 12px; }\n.afp-wb-download-item-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; }\n.afp-wb-download-save-section { display: grid; gap: 18px; }\n.afp-wb-download-modal .afp-wb-download-location { flex-wrap: wrap; justify-content: flex-start; padding: 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-2); }\n.afp-wb-download-modal .afp-wb-download-naming { grid-template-columns: minmax(0, 1fr); }\n.afp-wb-download-location > span { color: var(--dsw-alias-label-secondary); }\n.afp-wb-download-location > div { flex: 1; }\n.afp-wb-download-location strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 500; }\n.afp-wb-download-label { font-size: 11px; }\n.afp-wb-download-filename > summary { display: flex; align-items: center; gap: 8px; padding: 4px 0; cursor: pointer; list-style: none; font-size: 12px; }\n.afp-wb-download-filename > summary::-webkit-details-marker { display: none; }\n.afp-wb-download-filename > summary > span:nth-child(2) { margin-left: auto; color: var(--dsw-alias-label-secondary); }\n.afp-wb-download-filename > summary > svg { flex: none; color: var(--dsw-alias-label-secondary); transition: rotate var(--ds-transition-duration) var(--ds-ease-in-out); }\n.afp-wb-download-filename[open] > summary > svg { rotate: 180deg; }\n.afp-wb-download-filename > summary:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 3px; border-radius: var(--dsw-radius-sm); }\n.afp-wb-download-filename-fields { display: grid; gap: 10px; padding-top: 12px; }\n.afp-wb-download-filename[open] .afp-wb-download-filename-fields { animation: afpDownloadReveal var(--ds-transition-duration) var(--ds-ease-in-out); }\n.afp-wb-download-name-preview { display: grid; gap: 4px; min-width: 0; padding: 10px 12px; background: var(--dsw-alias-bg-layer-2); border-radius: var(--dsw-radius-sm); font-size: 11px; }\n.afp-wb-download-name-preview > span { margin-bottom: 2px; color: var(--dsw-alias-label-secondary); }\n.afp-wb-download-name-preview code { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--ds-font-family-code); user-select: text; }\n.afp-wb-download-hint { margin: 4px 0 0; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 17px; }\n.afp-wb-download-notice { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border-radius: var(--dsw-radius-sm); font-size: 12px; line-height: 19px; }\n.afp-wb-download-notice.is-error { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, var(--dsw-alias-bg-layer-1)); }\n.afp-wb-download-notice.is-warning { color: var(--dsw-alias-state-warn-primary); background: var(--dsw-alias-state-warn-tertiary); }\n.afp-wb-download-notice-actions { display: flex; flex: none; gap: 4px; }\n.afp-wb-download-skeleton { flex: 1; min-height: 0; overflow: hidden; }\n.afp-wb-download-skeleton-row { display: grid; grid-template-columns: 80px minmax(0, 1fr); gap: 14px; padding: 12px 10px; border-bottom: 1px solid var(--dsw-alias-border-l2); }\n.afp-wb-download-skeleton-row > div { display: grid; gap: 8px; }\n.afp-wb-download-skeleton-row > div > span { height: 14px; }\n.afp-wb-download-skeleton-row > div > span:nth-child(2) { width: 45%; height: 11px; }\n.afp-wb-download-skeleton-row > div > .afp-wb-download-skeleton-select { height: 32px; margin-top: 4px; }\n.afp-wb-download-skeleton-thumb { height: 60px; }\n.afp-wb-download-skeleton .afp-skeleton { background: linear-gradient(100deg, var(--dsw-alias-bg-skeleton) 25%, var(--dsw-alias-bg-layer-1) 50%, var(--dsw-alias-bg-skeleton) 75%); background-size: 240% 100%; animation: afpDownloadShimmer 1.8s var(--ds-ease-in-out) infinite; }\n@container afp-download-list (min-width: 560px) {\n  .afp-wb-download-item { grid-template-columns: 80px minmax(0, 1fr) 170px; align-items: center; }\n  .afp-wb-download-thumbnail { grid-row: auto; }\n  .afp-wb-download-item-quality { grid-column: 3; }\n  .afp-wb-download-skeleton-row { grid-template-columns: 80px minmax(0, 1fr) 170px; grid-template-rows: 22px 22px; gap: 8px 14px; align-items: center; }\n  .afp-wb-download-skeleton-thumb { grid-row: span 2; }\n  .afp-wb-download-skeleton-row > div { display: contents; }\n  .afp-wb-download-skeleton-row > div > span { grid-column: 2; }\n  .afp-wb-download-skeleton-row > div > .afp-wb-download-skeleton-select { grid-column: 3; grid-row: 1 / span 2; margin-top: 0; }\n}\n.afp-wb-download-review { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); font-size: 12px; }\n.afp-wb-download-review > span { color: var(--dsw-alias-label-secondary); }\n.afp-wb-download-footer { display: flex; flex: none; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 20px; border-top: 1px solid var(--dsw-alias-border-l2); }\n.afp-wb-download-total { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; min-width: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }\n.afp-wb-download-total strong { color: var(--dsw-alias-label-primary); font-size: 22px; font-weight: 500; line-height: 26px; }\n.afp-wb-download-total small { flex-basis: 100%; font-size: 11px; }\n.afp-wb-download-footer-actions { display: flex; flex: none; gap: 8px; }\n@keyframes afpDownloadReveal { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: translateY(0); } }\n@keyframes afpDownloadShimmer { from { background-position: 180% 0; } to { background-position: -80% 0; } }\n@media (max-width: 860px) {\n  .afp-wb-download-scroll { display: flex; flex-direction: column; overflow: auto; overscroll-behavior: contain; }\n  .afp-wb-download-quality-section { flex: none; }\n  .afp-wb-download-items { flex: none; overflow: visible; scrollbar-gutter: auto; }\n  .afp-wb-download-settings { flex: none; overflow: visible; border-left: 0; border-top: 1px solid var(--dsw-alias-border-l2); }\n  .afp-wb-download-modal .afp-wb-download-naming { grid-template-columns: repeat(2, minmax(0, 1fr)); }\n}\n@media (max-width: 560px) {\n  .afp-wb-download-header { padding: 16px 18px; gap: 8px; }\n  .afp-wb-download-heading-icon { display: none; }\n  .afp-wb-download-quality-section, .afp-wb-download-settings { padding: 14px 18px; }\n  .afp-wb-download-modal .afp-wb-download-naming { grid-template-columns: minmax(0, 1fr); }\n  .afp-wb-download-items { max-height: none; }\n  .afp-wb-download-item { grid-template-columns: 64px minmax(0, 1fr); gap: 8px 12px; }\n  .afp-wb-download-thumbnail { width: 64px; height: 48px; }\n  .afp-wb-download-item-quality { grid-column: 2; flex-direction: row; align-items: center; }\n  .afp-wb-download-item-quality > :first-child { min-width: 0; flex: 1; }\n  .afp-wb-download-footer { flex-wrap: wrap; padding: 14px 18px; gap: 10px; }\n  .afp-wb-download-footer-actions { margin-left: auto; }\n  .afp-wb-download-notice { flex-wrap: wrap; }\n}\n@media (prefers-reduced-motion: reduce) {\n  .afp-wb-download-modal * { animation: none !important; transition: none !important; }\n}\n.afp-download-overlay { position: fixed; z-index: 80; right: 0; bottom: 88px; width: 0; height: 0; pointer-events: none; color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 1.5; }\n.afp-download-overlay * { box-sizing: border-box; }\n.afp-download-edge-shell { position: absolute; right: 0; bottom: 0; pointer-events: auto; }\n.afp-download-overlay .afp-download-edge { position: relative; display: flex; flex-direction: column; gap: 4px; width: 40px; min-width: 40px; height: 52px; padding: 7px 6px; pointer-events: auto; border-radius: var(--dsw-radius-sm) 0 0 var(--dsw-radius-sm); border-right: 0; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); box-shadow: var(--dsw-elevation-stroke), var(--dsw-shadow-lv2); transition: background-color var(--ds-transition-duration) var(--ds-ease-in-out), color var(--ds-transition-duration) var(--ds-ease-in-out), width var(--ds-transition-duration) var(--ds-ease-in-out); }\n.afp-download-overlay .afp-download-edge:hover, .afp-download-overlay.is-open .afp-download-edge { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); width: 44px; }\n.afp-download-edge > span { font-size: 11px; font-variant-numeric: tabular-nums; }\n.afp-download-glyph.is-running { color: var(--dsw-alias-state-business-primary); }\n.afp-download-glyph.is-running .afp-download-glyph-arrow { animation: afp-download-arrow 1.6s var(--ds-ease-in-out) infinite; }\n.afp-download-glyph.is-running .afp-download-glyph-tray { animation: afp-download-tray 1.6s var(--ds-ease-in-out) infinite; }\n@keyframes afp-download-arrow { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(2px); } }\n@keyframes afp-download-tray { 0%, 100% { opacity: .6; } 50% { opacity: 1; } }\n.afp-download-card { position: absolute; right: 52px; bottom: 0; display: flex; flex-direction: column; width: min(340px, calc(100vw - 72px)); max-height: calc(100dvh - 112px - var(--dsh-frame-top-clearance, 0px)); min-height: 0; pointer-events: auto; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-shadow-lv3); opacity: 0; visibility: hidden; transform: translateX(calc(100% + 64px)); transition: transform 240ms var(--ds-ease-in-out), opacity 180ms var(--ds-ease-in-out), visibility 240ms; }\n.afp-download-overlay.is-open .afp-download-card { opacity: 1; visibility: visible; transform: translateX(0); }\n.afp-download-card > header { display: flex; flex: none; align-items: center; gap: 8px; padding: 12px; border-bottom: 1px solid var(--dsw-alias-border-l2); }\n.afp-download-card h2 { flex: 1; margin: 0; font-size: 13px; font-weight: 500; }\n.afp-download-records { min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 4px 12px; }\n.afp-download-record { padding: 12px 0; border-bottom: 1px solid var(--dsw-alias-border-l2); }\n.afp-download-record:last-child { border-bottom: 0; }\n.afp-download-record-heading { display: flex; align-items: center; gap: 6px; }\n.afp-download-record-heading > span:first-of-type { flex: 1; }\n.afp-download-file { margin: 8px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); font-size: 11px; }\n.afp-download-record progress { appearance: none; display: block; width: 100%; height: 4px; margin-top: 10px; overflow: hidden; border: 0; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-state-business-primary); }\n.afp-download-record progress::-webkit-progress-bar { background: var(--dsw-alias-bg-layer-2); }\n.afp-download-record progress::-webkit-progress-value { background: var(--dsw-alias-state-business-primary); transition: width var(--ds-transition-duration) var(--ds-ease-in-out); }\n.afp-download-record progress::-moz-progress-bar { background: var(--dsw-alias-state-business-primary); }\n.afp-download-record-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 28px; margin-top: 5px; color: var(--dsw-alias-label-secondary); font-size: 11px; font-variant-numeric: tabular-nums; }\n.afp-download-overlay button:focus-visible, .afp-download-card:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }\n@media (prefers-reduced-motion: reduce) {\n  .afp-download-overlay *, .afp-download-overlay progress::-webkit-progress-value { animation: none !important; transition: none !important; }\n}\n.afp-wb-action-modal-content { min-height: 0; overflow: auto; }\n.afp-wb-add-selection-summary { display: flex; align-items: center; gap: 14px; padding-bottom: 18px; border-bottom: 1px solid var(--dsw-alias-border-l2); }\n.afp-wb-add-selection-summary p { margin: 4px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; }\n.afp-wb-add-thumbnails { display: flex; flex: 0 0 auto; gap: 4px; }\n.afp-wb-add-thumbnails .afp-wb-image-stage { width: 44px; height: 38px; aspect-ratio: auto; border-radius: var(--dsw-radius-sm); }\n.afp-wb-add-targets { display: grid; gap: 12px; margin-top: 18px; }\n.afp-wb-add-target-list { display: grid; gap: 4px; max-height: 300px; overflow: auto; overscroll-behavior: contain; }\n.afp-wb-add-target-list .afp-wb-add-target { display: flex; align-items: center; justify-content: flex-start; gap: 10px; width: 100%; min-width: 0; height: 44px; padding: 8px 12px; }\n.afp-wb-add-target.is-selected { color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-interactive-bg-hover); box-shadow: inset 0 0 0 1px var(--dsw-alias-state-business-primary); }\n.afp-wb-add-target-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }\n.afp-wb-add-skeleton { display: grid; gap: 8px; }\n.afp-wb-add-skeleton > span { height: 44px; }\n.afp-wb-add-result { display: grid; gap: 12px; margin-top: 18px; }\n.afp-wb-add-result p { margin: 0; color: var(--dsw-alias-label-secondary); }\n.afp-wb-add-result-tags { display: flex; flex-wrap: wrap; gap: 8px; }\n.afp-wb-add-result-row { display: flex; align-items: center; gap: 12px; min-width: 0; }\n.afp-wb-add-result-row > span:first-child { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }\n@media (max-width: 500px) { .afp-wb-add-selection-summary { align-items: flex-start; flex-direction: column; } }\n.afp-wb-download-dialog, .afp-wb-operation-dialog { display: grid; gap: 14px; min-width: 0; }\n.afp-wb-action-summary { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--dsw-alias-label-secondary); }\n.afp-wb-download-renditions { display: grid; gap: 8px; max-height: min(34dvh, 300px); overflow: auto; overscroll-behavior: contain; padding: 1px 4px 1px 1px; }\n.afp-wb-download-photo { display: grid; grid-template-columns: minmax(0, 1fr) minmax(190px, 1fr); align-items: center; gap: 12px; padding: 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-base); }\n.afp-wb-download-photo-title { display: grid; min-width: 0; gap: 3px; }\n.afp-wb-download-photo-title strong, .afp-wb-download-photo-title span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.afp-wb-download-photo-title span { color: var(--dsw-alias-label-tertiary); font-size: 11px; }\n.afp-wb-download-location { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; padding: 10px 12px; border-radius: 10px; background: var(--dsw-alias-bg-module-platform); }\n.afp-wb-download-location > div { display: grid; min-width: 0; gap: 3px; }\n.afp-wb-download-location > div span { overflow: hidden; color: var(--dsw-alias-label-secondary); text-overflow: ellipsis; white-space: nowrap; }\n.afp-wb-download-naming { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }\n.afp-wb-download-naming label, .afp-wb-dialog-field { display: grid; gap: 6px; color: var(--dsw-alias-label-secondary); font-size: 12px; }\n.afp-wb-credit-summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border-radius: 10px; background: var(--dsw-alias-bg-module-platform); font-variant-numeric: tabular-nums; }\n.afp-wb-credit-summary > span { color: var(--dsw-alias-label-secondary); }\n.afp-wb-download-plan { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; }\n.afp-wb-download-plan h4 { margin: 0; font-size: 13px; }\n.afp-wb-download-plan-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px; }\n.afp-wb-download-plan-row code { grid-column: 1 / -1; overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); font-size: 11px; }\n.afp-wb-download-warning { margin: 0; color: var(--dsw-alias-state-warn-primary); font-size: 12px; }\n.afp-wb-download-success { margin: 0; color: var(--dsw-alias-state-success-primary); }\n.afp-wb-transfer-mode { display: flex; flex-wrap: wrap; gap: 8px; }\n.afp-wb-dialog-footer { display: flex; justify-content: flex-end; gap: 8px; }\n.afp-wb-operation-result { display: grid; gap: 4px; padding: 10px 12px; border-radius: 10px; background: var(--dsw-alias-bg-module-platform); }\n.afp-wb-operation-result p { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; }\n.afp-wb-download-tasks { display: grid; gap: 8px; margin-top: 18px; }\n.afp-wb-download-tasks > h4 { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 500; }\n.afp-wb-download-task { min-width: 0; padding: 9px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 9px; }\n.afp-wb-download-task > summary { display: flex; align-items: center; gap: 8px; cursor: pointer; list-style: none; }\n.afp-wb-download-task > summary::-webkit-details-marker { display: none; }\n.afp-wb-download-task-title { flex: 1; min-width: 0; font-size: 12px; }\n.afp-wb-download-task > p { margin: 8px 0; }\n.afp-wb-download-task-files { display: grid; gap: 6px; margin: 8px 0; }\n.afp-wb-download-task-files > p { display: flex; align-items: center; gap: 6px; min-width: 0; margin: 0; }\n.afp-wb-download-task-files > p > span:first-child { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n@container (max-width: 500px) {\n  .afp-wb-download-photo { grid-template-columns: minmax(0, 1fr); }\n  .afp-wb-download-naming { grid-template-columns: minmax(0, 1fr); }\n  .afp-wb-download-task > summary { flex-wrap: wrap; }\n}\n";

  // src/client/afp-client-entry.js
  window.__ModuleLoader__.load({ id: "dsh-plugin-afp", factory(require2) {
    const React = require2("react"), primitives = require2("@deepseek-ai/dsh-client-ui-primitives");
    const { Switch, Input, Button, StateDot, Tag, Checkbox, Toast, Menu, MenuSurface, SegmentedControl, Tooltip, Modal, GlideHighlight, useDismissOnOutsidePointer } = primitives;
    const { createPortal } = require2("react-dom");
    const icons = Object.fromEntries([
      "IconSearchOutlineRegular",
      "IconFolderCloseRegular",
      "IconFlatListOutlineRegular",
      "IconRefreshOutlineRegular",
      "IconSettingsOutlineRegular",
      "IconCloseOutlineRegular",
      "IconChevronDownOutlineRegular",
      "IconSkillOutlineRegular",
      "IconCodeOutlineRegular",
      "IconPanelLeftOutlineRegular",
      "IconCheckOutlineRegular",
      "IconDownloadOutlineRegular",
      "IconTrashOutlineRegular",
      "IconFolderOpenOutlineRegular",
      "IconSlidersTwoOutlineRegular"
    ].map((name) => [name, primitives[name]]));
    return { inject: ["slots", "locale", "remote", "remote.pluginManager", "remote.credentials", "layout", "uiConversation"], apply(ctx) {
      const namespace = "afpWorkbench", panel = "afp-workbench";
      ctx.effect(() => ctx.locale.register(namespace, { en: en_default, zh: zh_default }), "AFP locale");
      const t = ctx.locale.bind(namespace), store = createAfpClientStore(ctx);
      const ConfigurationForm = createConfigurationForm(React, { Input, Button, StateDot, Tag, Toast, Tooltip, Chevron: icons.IconChevronDownOutlineRegular }, ctx, t);
      const Workbench = createWorkbench(React, { Switch, Input, Button, StateDot, Tag, Checkbox, Toast, Menu, MenuSurface, createPortal, useDismissOnOutsidePointer, SegmentedControl, Tooltip, Modal, GlideHighlight }, ctx, t, store, ConfigurationForm, icons);
      const DownloadOverlay = createAfpDownloadOverlay(React, { Button, Tag, Toast, StateDot, Tooltip, Menu, useDismissOnOutsidePointer }, icons, t, store, () => {
        store.selectTab("tasks");
        ctx.layout.selectPanel(panel);
      });
      ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "afp.download-overlay", locale: namespace }, DownloadOverlay));
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
        const status = store.getSnapshot().status;
        if (!status) return;
        const flags = status.features ?? [];
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
        const credentialChanges = ctx.remote.$on("credentials/reference-updated", (ref) => {
          void store.credentialReferenceUpdated(typeof ref === "string" ? ref : ref?.ref);
        });
        const reset = ctx.on("connection/reset", () => {
          void store.resetAndReload();
        });
        let timer, stopped = false;
        const poll = async () => {
          const priorTasks = new Set((store.getSnapshot().status?.tasks ?? []).map((task) => task.taskId));
          await store.reload();
          const currentTasks = store.getSnapshot().status?.tasks ?? [];
          if ([...priorTasks].some((id) => !currentTasks.some((task) => task.taskId === id))) store.refreshCompletedTaskData();
          if (!stopped) timer = setTimeout(poll, store.getSnapshot().status?.pollIntervalMs ?? 2e3);
        };
        void store.loadAccount();
        void poll();
        return () => {
          stopped = true;
          clearTimeout(timer);
          unsubscribe();
          changed();
          credentialChanges();
          reset();
          for (const remove of registrations.values()) remove();
          registrations.clear();
        };
      }, "AFP entry lifecycle");
    } };
  } });
})();
