function initializeRive(fileName, vscode) {
  const $ = (id) => document.getElementById(id);
  const canvas = $("canvas");
  const artboardSelect = $("artboardSelect");
  const machineSelect = $("machineSelect");
  const animationList = $("animationList");
  const inputList = $("inputList");
  let selectedAnimation = "";
  let contents;
  let riveBuffer;
  let riveInstance;
  let previewGeneration = 0;
  let toastTimer;
  let zoom = 1;
  let lastTimelinePaint = 0;
  const loadTimeoutMs = 30000;

  const log = (level, message, detail) => {
    vscode.postMessage({
      type: "log",
      level,
      message,
      detail: detail ? String(detail).slice(0, 10000) : undefined,
    });
  };
  const describeError = (error) => {
    if (error instanceof Error) return error.stack || error.message;
    if (error?.data !== undefined) return String(error.data);
    if (error?.message) return String(error.message);
    return String(error || "No error details were provided by the Rive runtime.");
  };
  const copy = (text, label) => {
    if (!text) return;
    vscode.postMessage({ type: "copyText", text, label });
  };
  const toast = (message) => {
    const node = $("toast");
    node.textContent = message;
    node.classList.add("translate-y-0", "opacity-100");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(
      () => node.classList.remove("translate-y-0", "opacity-100"),
      1800
    );
  };
  window.addEventListener("message", (event) => {
    if (event.data?.type === "loadAsset") {
      clearTimeout(hostHandshakeTimer);
      if (!(event.data.buffer instanceof ArrayBuffer)) {
        setStatus("Could not read asset data. See Output for details.", "error");
        log("error", "The extension host sent invalid Rive file data.");
        return;
      }
      riveBuffer = event.data.buffer;
      fileName = event.data.fileName || fileName;
      updateAssetName();
      startMetadataLoad();
      return;
    }
    if (event.data?.type === "copyComplete") toast(`${event.data.label || "Item"} copied`);
    if (event.data?.type === "copyError") toast("Could not copy to clipboard");
    if (event.data?.type === "screenshotSaved") toast(`Screenshot saved${event.data.fileName ? `: ${event.data.fileName}` : ""}`);
    if (event.data?.type === "screenshotCancelled") toast("Screenshot save cancelled");
    if (event.data?.type === "screenshotError") toast("Could not save screenshot");
  });
  const option = (select, value, label = value) => {
    const item = document.createElement("option");
    item.value = value;
    item.textContent = label;
    select.appendChild(item);
  };
  const activeArtboard = () => contents?.artboards?.find((item) => item.name === artboardSelect.value);
  const activeMachine = () => activeArtboard()?.stateMachines?.find((item) => item.name === machineSelect.value);
  const formatTime = (seconds) => {
    const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    const minutes = Math.floor(safe / 60);
    return `${minutes}:${(safe % 60).toFixed(2).padStart(5, "0")}`;
  };
  const setStatus = (message, state = "ready") => {
    const status = $("status");
    status.textContent = message;
    status.title = message;
    status.dataset.state = state;
  };
  const updateAssetName = () => {
    const heading = $("assetName");
    heading.textContent = fileName || "Rive preview";
    heading.title = fileName || "Rive preview";
  };
  updateAssetName();

  function updateAssetSummary() {
    const artboards = contents?.artboards || [];
    const animationCount = artboards.reduce((sum, item) => sum + (item.animations?.length || 0), 0);
    const machineCount = artboards.reduce((sum, item) => sum + (item.stateMachines?.length || 0), 0);
    const stats = [
      [artboards.length, "Artboards"],
      [animationCount, "Timelines"],
      [machineCount, "State machines"],
    ];
    const bounds = riveInstance?.artboard?.bounds;
    if (bounds) stats.push([`${Math.round(bounds.maxX - bounds.minX)} × ${Math.round(bounds.maxY - bounds.minY)}`, "Artboard px"]);
    const fps = riveInstance?.fps;
    if (Number.isFinite(fps) && fps > 0) stats.push([fps, "Preview FPS"]);
    const summary = $("assetSummary");
    summary.replaceChildren();
    summary.hidden = false;
    summary.classList.remove("hidden");
    stats.forEach(([value, label]) => {
      const stat = document.createElement("div");
      stat.className =
        "inline-flex items-baseline gap-[5px] rounded-[5px] border border-border bg-raised px-2 py-[3px] [font-variant-numeric:tabular-nums]";
      const number = document.createElement("strong");
      number.className = "text-[11px] font-semibold";
      number.textContent = value;
      const caption = document.createElement("span");
      caption.className = "text-[9px] text-muted";
      caption.textContent = label;
      stat.append(number, caption);
      summary.appendChild(stat);
    });
  }

  function updateTimeline() {
    const name = selectedAnimation;
    const animation = name && riveInstance?.artboard?.animationByName(name);
    const scrubber = $("timelineScrubber");
    if (!animation || machineSelect.value) {
      const stateMachineSelected = Boolean(machineSelect.value);
      $("timelineTitle").textContent = stateMachineSelected
        ? `${machineSelect.value} · state machine`
        : "No timeline selected";
      $("timelineDetails").textContent = machineSelect.value ? "State machines can run indefinitely" : "";
      $("timingNote").textContent = stateMachineSelected
        ? "State machines are interactive and may run indefinitely."
        : "Timeline duration and looping vary by animation.";
      scrubber.disabled = true;
      scrubber.max = "0";
      scrubber.value = "0";
      $("elapsedTime").textContent = "0:00.00";
      $("totalTime").textContent = "0:00.00";
      return;
    }
    const durationFrames = Number(animation.duration) || 0;
    const fps = Number(animation.fps) || 0;
    const duration = fps > 0 ? durationFrames / fps : 0;
    const startFrames = Number(animation.workStart);
    const endValue = Number(animation.workEnd);
    const start = fps > 0 ? (Number.isFinite(startFrames) && startFrames >= 0 ? startFrames : 0) / fps : 0;
    const endFrames = Number.isFinite(endValue) && endValue > 0 ? endValue : durationFrames;
    const end = fps > 0 ? endFrames / fps : duration;
    $("timingNote").textContent = "Scrub the timeline to inspect playback.";
    const loopValues = { 0: "One-shot", 1: "Loop", 2: "Ping-pong", oneshot: "One-shot", loop: "Loop", pingpong: "Ping-pong" };
    const loop = loopValues[animation.loopValue] || "Timeline";
    $("timelineTitle").textContent = name;
    $("timelineDetails").textContent = `${duration.toFixed(2)} s · ${durationFrames} frames · ${fps ? `${fps} FPS · ` : ""}${loop} · work ${start.toFixed(2)}–${end.toFixed(2)} s`;
    scrubber.disabled = duration <= 0;
    scrubber.max = String(duration);
    $("totalTime").textContent = formatTime(duration);
    const instance = riveInstance.animator?.animations?.find((item) => item.name === name);
    const time = Math.min(duration, Math.max(0, Number(instance?.time) || 0));
    if (document.activeElement !== scrubber) scrubber.value = String(time);
    $("elapsedTime").textContent = formatTime(time);
  }

  function setZoom(nextZoom) {
    zoom = Math.max(0.5, Math.min(3, Math.round(nextZoom * 4) / 4));
    canvas.style.transform = `scale(${zoom})`;
    $("zoomReset").textContent = `${Math.round(zoom * 100)}%`;
  }

  function renderAnimations() {
    const artboard = activeArtboard();
    animationList.replaceChildren();
    const animations = artboard?.animations || [];
    selectedAnimation = animations[0] || "";
    if (animations.length) {
      animations.forEach((name) => {
        const row = document.createElement("div");
        row.className =
          `flex min-h-7 items-center gap-1.5 rounded border px-1.5 py-0.5 text-[11px] transition-colors ${
            name === selectedAnimation
              ? "border-accent/55 bg-accent/10"
              : "border-transparent bg-raised hover:border-border"
          }`;
        const select = document.createElement("button");
        select.className =
          "min-w-0 flex-1 cursor-pointer overflow-hidden border-0 bg-transparent px-1 py-1 text-left text-ellipsis whitespace-nowrap hover:text-link focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2";
        select.textContent = name;
        select.title = `Select ${name}`;
        select.addEventListener("click", () => {
          selectAnimation(name);
        });
        const copyButton = document.createElement("button");
        copyButton.className =
          "cursor-pointer rounded-[5px] border border-border bg-transparent px-[7px] py-[3px] text-[9px] text-muted transition-colors hover:border-accent/55 hover:bg-accent/15 focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2";
        copyButton.textContent = "Copy";
        copyButton.setAttribute("aria-label", `Copy animation ${name}`);
        copyButton.addEventListener("click", () => copy(name, "Animation name"));
        row.append(select, copyButton);
        animationList.appendChild(row);
      });
    } else {
      animationList.innerHTML =
        '<p class="text-[10px] text-muted">No timeline animations on this artboard.</p>';
    }
  }

  function selectAnimation(name) {
    selectedAnimation = name;
    machineSelect.value = "";
    Array.from(animationList.children).forEach((row) => {
      const selected = row.querySelector("button")?.textContent === name;
      row.classList.toggle("border-accent/55", selected);
      row.classList.toggle("bg-accent/10", selected);
      row.classList.toggle("border-transparent", !selected);
      row.classList.toggle("bg-raised", !selected);
    });
    renderInputs();
    updateTimeline();
    playSelected();
  }

  function renderMachines() {
    const machines = activeArtboard()?.stateMachines || [];
    machineSelect.replaceChildren();
    option(machineSelect, "", machines.length ? "Choose state machine" : "No state machines");
    machines.forEach((machine) => option(machineSelect, machine.name));
    machineSelect.disabled = !machines.length;
    $("copyMachine").disabled = !machines.length;
    $("copyMachine").onclick = () => copy(machineSelect.value, "State machine name");
    renderInputs();
    updateTimeline();
  }

  function renderInputs() {
    inputList.replaceChildren();
    const machine = activeMachine();
    const inputs = machine?.inputs || [];
    $("copyMachine").disabled = !machine;
    if (!machine || !inputs.length) {
      const message = machine
        ? "No inputs on this state machine."
        : (activeArtboard()?.stateMachines?.length
          ? "Choose a state machine to inspect its inputs."
          : "No state machines on this artboard.");
      inputList.innerHTML = `<p class="text-[10px] text-muted">${message}</p>`;
      return;
    }
    inputs.forEach((metadata) => {
      const row = document.createElement("div");
      row.className =
        "input-row flex min-h-7 items-center gap-1.5 rounded border border-transparent bg-raised px-1.5 py-0.5 text-[11px] transition-colors hover:border-border";
      const name = document.createElement("span");
      name.className =
        "input-name min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap";
      name.textContent = metadata.name;
      name.dataset.inputName = metadata.name;
      const type = metadata.type;
      let control;
      if (type === rive.StateMachineInputType.Trigger) {
        control = document.createElement("button");
        control.className =
          "small-button h-6 min-w-11 cursor-pointer rounded border border-border bg-input text-[9px] hover:bg-accent/15 focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2 disabled:cursor-default disabled:opacity-45";
        control.textContent = "Fire";
        control.disabled = true;
        control.addEventListener("click", () => getRuntimeInput(metadata.name)?.fire());
      } else if (type === rive.StateMachineInputType.Boolean) {
        control = document.createElement("input");
        control.type = "checkbox";
        control.className =
          "size-4 accent-accent focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2";
        control.disabled = true;
        control.setAttribute("aria-label", metadata.name);
        control.addEventListener("change", () => {
          const input = getRuntimeInput(metadata.name);
          if (input) input.value = control.checked;
        });
      } else if (type === rive.StateMachineInputType.Number) {
        control = document.createElement("input");
        control.type = "number";
        control.className =
          "h-6 w-[72px] min-w-[72px] rounded border border-border bg-input px-1.5 text-[10px] text-text focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2";
        control.step = "any";
        control.value = "0";
        control.disabled = true;
        control.setAttribute("aria-label", metadata.name);
        control.addEventListener("input", () => {
          const input = getRuntimeInput(metadata.name);
          if (input && control.value !== "") input.value = Number(control.value);
        });
      } else {
        control = document.createElement("span");
        control.className = "text-[10px] text-muted";
        control.textContent = `Unsupported type ${type}`;
      }
      const copyButton = document.createElement("button");
      copyButton.className =
        "cursor-pointer rounded-[5px] border border-border bg-transparent px-[7px] py-[3px] text-[9px] text-muted transition-colors hover:border-accent/55 hover:bg-accent/15 focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2";
      copyButton.textContent = "Copy";
      copyButton.setAttribute("aria-label", `Copy input ${metadata.name}`);
      copyButton.addEventListener("click", () => copy(metadata.name, "Input name"));
      row.append(name, control, copyButton);
      inputList.appendChild(row);
    });
  }

  function syncInputControls() {
    inputList.querySelectorAll(".input-row").forEach((row) => {
      const name = row.querySelector(".input-name")?.dataset.inputName;
      const input = name ? getRuntimeInput(name) : undefined;
      const control = row.querySelector("input, .small-button");
      if (!control) return;
      control.disabled = !input;
      if (!input) return;
      if (control instanceof HTMLInputElement && control.type === "checkbox") {
        control.checked = Boolean(input.value);
      } else if (control instanceof HTMLInputElement && control.type === "number") {
        control.value = String(Number(input.value) || 0);
      }
    });
  }

  function getRuntimeInput(name) {
    if (!riveInstance || !machineSelect.value) return undefined;
    return (riveInstance.stateMachineInputs(machineSelect.value) || []).find((input) => input.name === name);
  }

  function playSelected() {
    if (!riveInstance) return;
    riveInstance.stop();
    const selected = machineSelect.value || selectedAnimation;
    if (selected) riveInstance.play(selected);
  }

  function loadPreview() {
    const generation = ++previewGeneration;
    $("screenshotButton").disabled = true;
    clearTimeout(previewLoadTimer);
    if (riveInstance) {
      try {
        riveInstance.stop();
        riveInstance.cleanup();
      } catch (error) {
        log("error", "Could not clean up the previous canvas preview.", describeError(error));
      }
    }
    riveInstance = undefined;
    const artboard = artboardSelect.value;
    if (!artboard) return;
    setStatus("Loading preview…", "loading");
    let settled = false;
    let loadTimer;
    let instance;
    const previewAssets = [];
    loadTimer = window.setTimeout(() => {
      if (settled || generation !== previewGeneration) return;
      settled = true;
      setStatus("Preview timed out. See Output for details.", "error");
      log(
        "error",
        `Canvas preview timed out after ${loadTimeoutMs / 1000}s (artboard: ${artboard}).`,
        `The file metadata loaded, but the preview runtime did not finish loading. Assets encountered: ${previewAssets.join("; ") || "none"}.`
      );
      if (previewLoadTimer === loadTimer) previewLoadTimer = undefined;
      if (riveInstance === instance) {
        riveInstance = undefined;
        try {
          instance?.cleanup();
        } catch (error) {
          log("error", "Could not clean up the timed-out canvas preview.", describeError(error));
        }
      }
    }, loadTimeoutMs);
    previewLoadTimer = loadTimer;
    try {
      instance = new rive.Rive({
        buffer: riveBuffer,
        canvas,
        artboard,
        layout: new rive.Layout({ fit: $("fitSelect").value }),
        autoplay: false,
        autoBind: true,
        enableRiveAssetCDN: false,
        assetLoader: (asset, bytes) => {
          const assetDetails = `${asset.name || "unnamed"} (${asset.isImage ? "image" : asset.isFont ? "font" : asset.isAudio ? "audio" : "asset"}, ${bytes.byteLength} bytes${asset.cdnUuid ? ", has CDN reference" : ""})`;
          previewAssets.push(assetDetails);
          if (bytes.byteLength > 0 && (asset.isImage || asset.isFont || asset.isAudio)) {
            try {
              asset.decode(bytes);
              return true;
            } catch (error) {
              log("error", `Could not decode embedded preview ${asset.isImage ? "image" : asset.isFont ? "font" : "audio"} asset ${asset.name || "unnamed"}.`, describeError(error));
              return false;
            }
          }
          if (bytes.byteLength === 0) {
            log(
              "warning",
              `Preview ${asset.isImage ? "image " : ""}asset ${asset.name || "unnamed"} has no embedded bytes${asset.cdnUuid ? " and its CDN fallback is disabled" : ""}.`
            );
            return true;
          }
          return false;
        },
        onLoad: () => {
          if (settled) {
            try {
              instance?.cleanup();
              log("warning", `Canvas preview completed after timing out (artboard: ${artboard}); closed the late preview.`);
            } catch (error) {
              log("error", "Could not clean up the late canvas preview.", describeError(error));
            }
            return;
          }
          clearTimeout(loadTimer);
          if (previewLoadTimer === loadTimer) previewLoadTimer = undefined;
          settled = true;
          if (generation !== previewGeneration) {
            instance?.cleanup();
            return;
          }
          try {
          riveInstance.resizeDrawingSurfaceToCanvas();
          if (machineSelect.value) riveInstance.play(machineSelect.value);
          else if (selectedAnimation) riveInstance.play(selectedAnimation);
          syncInputControls();
          $("screenshotButton").disabled = false;
          setStatus("Ready");
          updateAssetSummary();
          updateTimeline();
          } catch (error) {
            setStatus("Could not initialize preview. See Output for details.", "error");
            log("error", `Canvas preview initialization failed (artboard: ${artboard}).`, describeError(error));
          }
        },
        onLoadError: (error) => {
          if (settled) return;
          clearTimeout(loadTimer);
          if (previewLoadTimer === loadTimer) previewLoadTimer = undefined;
          settled = true;
          if (generation === previewGeneration) {
            setStatus("Could not load preview. See Output for details.", "error");
            log("error", `Canvas preview failed to load (artboard: ${artboard}).`, describeError(error));
            if (riveInstance === instance) riveInstance = undefined;
            try {
              instance?.cleanup();
            } catch (cleanupError) {
              log("error", "Could not clean up the failed canvas preview.", describeError(cleanupError));
            }
          } else {
            instance?.cleanup();
          }
        },
        onAdvance: () => {
          const now = performance.now();
          if (now - lastTimelinePaint > 100) {
            lastTimelinePaint = now;
            updateTimeline();
            updateAssetSummary();
          }
        },
      });
      riveInstance = instance;
    } catch (error) {
      clearTimeout(loadTimer);
      if (previewLoadTimer === loadTimer) previewLoadTimer = undefined;
      settled = true;
      setStatus("Could not initialize preview. See Output for details.", "error");
      log("error", `Canvas preview could not be initialized (artboard: ${artboard}).`, describeError(error));
    }
  }

  let previewLoadTimer;
  let metadataLoadTimer;
  let hostHandshakeTimer;
  let metadataLoader;
  let metadataSettled = false;

  function startMetadataLoad() {
    if (metadataLoader || metadataSettled) return;
    metadataLoadTimer = window.setTimeout(() => {
      if (metadataSettled) return;
      metadataSettled = true;
      setStatus("Asset loading timed out. See Output for details.", "error");
      log(
        "error",
        `Rive metadata loading timed out after ${loadTimeoutMs / 1000}s.`,
        "The Rive runtime did not finish parsing the file after the extension host supplied its bytes."
      );
      try {
        metadataLoader?.cleanup();
      } catch (error) {
        log("error", "Could not clean up the timed-out metadata loader.", describeError(error));
      }
    }, loadTimeoutMs);
    try {
      metadataLoader = new rive.Rive({
        buffer: riveBuffer,
        canvas,
        autoplay: false,
        assetLoader: () => true,
        onLoad: () => {
          clearTimeout(metadataLoadTimer);
          if (metadataSettled) {
            try {
              metadataLoader.cleanup();
            } catch (error) {
              log("error", "Could not clean up the late metadata loader.", describeError(error));
            }
            return;
          }
          metadataSettled = true;
          try {
            contents = metadataLoader.contents;
            metadataLoader.cleanup();
            const artboards = contents?.artboards || [];
            artboardSelect.replaceChildren();
            artboards.forEach((item) => option(artboardSelect, item.name));
            $("emptyState").hidden = artboards.length > 0;
            if (!artboards.length) {
              setStatus("No artboards found. See Output for details.", "error");
              log("error", "The Rive file loaded but contains no artboards.");
              return;
            }
            setStatus("Ready");
            updateAssetSummary();
            renderAnimations();
            renderMachines();
            loadPreview();
          } catch (error) {
            setStatus("Could not read asset metadata. See Output for details.", "error");
            log("error", "Rive metadata was loaded but could not be read.", describeError(error));
          }
        },
        onLoadError: (error) => {
          clearTimeout(metadataLoadTimer);
          if (metadataSettled) return;
          metadataSettled = true;
          setStatus("Could not open this Rive file. See Output for details.", "error");
          log("error", "Rive metadata loading failed.", describeError(error));
        },
      });
    } catch (error) {
      clearTimeout(metadataLoadTimer);
      metadataSettled = true;
      setStatus("Could not open this Rive file. See Output for details.", "error");
      log("error", "Rive metadata loader could not be initialized.", describeError(error));
    }
  }

  hostHandshakeTimer = window.setTimeout(() => {
    setStatus("Could not read asset data. See Output for details.", "error");
    log("error", "Timed out waiting for the extension host to provide the Rive file data.");
  }, loadTimeoutMs);
  vscode.postMessage({ type: "ready" });

  artboardSelect.addEventListener("change", () => {
    renderAnimations();
    renderMachines();
    loadPreview();
  });
  $("copyArtboard").addEventListener("click", () => copy(artboardSelect.value, "Artboard name"));
  machineSelect.addEventListener("change", () => {
    if (machineSelect.value) {
      selectedAnimation = "";
      Array.from(animationList.children).forEach((row) => {
        row.classList.remove("border-accent/55", "bg-accent/10");
        row.classList.add("border-transparent", "bg-raised");
      });
    }
    renderInputs();
    loadPreview();
  });
  $("fitSelect").addEventListener("change", loadPreview);
  $("screenshotButton").addEventListener("click", () => {
    if (!riveInstance) return;
    try {
      vscode.postMessage({
        type: "saveScreenshot",
        data: canvas.toDataURL("image/png"),
      });
    } catch (error) {
      log("error", "Could not capture preview screenshot.", describeError(error));
      toast("Could not capture screenshot");
    }
  });
  $("playButton").addEventListener("click", playSelected);
  $("pauseButton").addEventListener("click", () => riveInstance?.pause());
  $("stopButton").addEventListener("click", () => { riveInstance?.stop(); updateTimeline(); });
  $("background").addEventListener("input", (event) => { $("canvas").style.backgroundColor = event.target.value; });
  $("zoomOut").addEventListener("click", () => setZoom(zoom - 0.25));
  $("zoomIn").addEventListener("click", () => setZoom(zoom + 0.25));
  $("zoomReset").addEventListener("click", () => setZoom(1));
  $("timelineScrubber").addEventListener("input", (event) => {
    const name = selectedAnimation;
    if (!name || !riveInstance) return;
    const running = riveInstance.animator?.animations?.some((item) => item.name === name);
    if (!running) {
      riveInstance.play(name);
      riveInstance.pause(name);
    } else {
      riveInstance.pause(name);
    }
    riveInstance.scrub(name, Number(event.target.value));
    $("elapsedTime").textContent = formatTime(Number(event.target.value));
  });
  $("canvas").parentElement.addEventListener("wheel", (event) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      setZoom(zoom + (event.deltaY < 0 ? 0.25 : -0.25));
    }
  }, { passive: false });
  window.addEventListener("keydown", (event) => {
    if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
    if (event.key === "+" || event.key === "=") setZoom(zoom + 0.25);
    else if (event.key === "-") setZoom(zoom - 0.25);
    else if (event.key === "0") setZoom(1);
  });
  window.addEventListener("resize", () => riveInstance?.resizeDrawingSurfaceToCanvas());
  window.addEventListener("error", (event) => {
    log("error", "Uncaught webview error.", event.error?.stack || event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    log("error", "Unhandled webview promise rejection.", describeError(event.reason));
  });
}
