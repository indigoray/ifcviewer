import "./style.css";

import Stats from "stats.js";
import * as OBC from "@thatopen/components";

type ViewerWorld = OBC.World<
  OBC.SimpleScene,
  OBC.OrthoPerspectiveCamera,
  OBC.SimpleRenderer
>;

const SAMPLE_IFC_URL =
  "https://thatopen.github.io/engine_components/resources/ifc/school_str.ifc";

void bootstrap().catch((error) => {
  console.error("Failed to start viewer", error);
});

async function bootstrap() {
  const viewerRoot = document.getElementById("viewer");
  const uiRoot = document.getElementById("ui");

  if (!(viewerRoot instanceof HTMLElement) || !(uiRoot instanceof HTMLElement)) {
    throw new Error("Viewer container not found");
  }

  const components = new OBC.Components();
  const world = await setupWorld(components, viewerRoot);

  const fragments = components.get(OBC.FragmentsManager);
  const workerUrl = await prepareFragments(world, fragments);

  const ifcLoader = components.get(OBC.IfcLoader);
  await ifcLoader.setup({
    autoSetWasm: false,
    wasm: {
      path: "https://unpkg.com/web-ifc@0.0.71/",
      absolute: true
    }
  });

  const ui = buildUi(uiRoot);
  ui.setStatus("모델을 선택하거나 샘플을 불러와 주세요.");

  let busy = false;

  const queue = async (task: () => Promise<void>) => {
    if (busy) {
      return;
    }
    busy = true;
    ui.setBusy(true);
    try {
      await task();
    } catch (error) {
      ui.setStatus("문제가 발생했습니다. 콘솔을 확인해 주세요.");
      console.error(error);
    } finally {
      busy = false;
      ui.setBusy(false);
      ui.setProgress(null);
    }
  };

  ui.onSample(() =>
    queue(async () => {
      ui.setStatus("샘플 IFC 파일을 다운로드 중입니다.");
      const buffer = await fetchIfc(SAMPLE_IFC_URL);
      await loadIfcBuffer(buffer, "샘플 모델");
    })
  );

  ui.onFile((file) =>
    queue(async () => {
      ui.setStatus(`"${file.name}" 파일을 변환 중입니다.`);
      const buffer = await readFile(file);
      await loadIfcBuffer(buffer, file.name);
    })
  );

  window.addEventListener("beforeunload", () => {
    URL.revokeObjectURL(workerUrl);
  });

  async function loadIfcBuffer(buffer: Uint8Array, label: string) {
    ui.setProgress(0);
    const model = await ifcLoader.load(buffer, false, label, {
      processData: {
        progressCallback: (state) => {
          const ratio = extractProgress(state);
          if (ratio !== undefined) {
            ui.setProgress(ratio);
            ui.setStatus(
              `${label} 변환 중... ${Math.round(ratio * 100)}%`
            );
          } else {
            ui.setStatus(`${label} 데이터를 준비 중입니다.`);
          }
        }
      }
    });

    model.useCamera(world.camera.three);
    world.scene.three.add(model.object);
    fragments.core.update(true);
    ui.setStatus(`${label} 로딩이 완료되었습니다.`);
  }
}

async function setupWorld(
  components: OBC.Components,
  container: HTMLElement
): Promise<ViewerWorld> {
  const worlds = components.get(OBC.Worlds);
  const world = worlds.create<
    OBC.SimpleScene,
    OBC.OrthoPerspectiveCamera,
    OBC.SimpleRenderer
  >();

  world.scene = new OBC.SimpleScene(components);
  world.scene.setup();
  world.scene.three.background = null;

  world.renderer = new OBC.SimpleRenderer(components, container);
  world.camera = new OBC.OrthoPerspectiveCamera(components);
  await world.camera.controls.setLookAt(60, 35, 60, 0, 0, 0);

  components.init();
  components.get(OBC.Grids).create(world);

  const stats = new Stats();
  stats.showPanel(0);
  stats.dom.style.position = "absolute";
  stats.dom.style.left = "1rem";
  stats.dom.style.top = "1rem";
  stats.dom.style.pointerEvents = "none";
  container.append(stats.dom);

  world.renderer.onBeforeUpdate.add(() => stats.begin());
  world.renderer.onAfterUpdate.add(() => stats.end());

  return world;
}

async function prepareFragments(
  world: ViewerWorld,
  fragments: OBC.FragmentsManager
) {
  const workerUrl = await createFragmentWorker();
  fragments.init(workerUrl);

  world.camera.controls.addEventListener("rest", () => {
    fragments.core.update(true);
  });

  return workerUrl;
}

async function createFragmentWorker() {
  const response = await fetch(
    "https://thatopen.github.io/engine_fragment/resources/worker.mjs"
  );
  if (!response.ok) {
    throw new Error("Failed to download fragment worker");
  }
  const blob = await response.blob();
  const file = new File([blob], "worker.mjs", {
    type: "text/javascript"
  });
  return URL.createObjectURL(file);
}

function buildUi(root: HTMLElement) {
  root.innerHTML = "";

  const title = document.createElement("h1");
  title.textContent = "Ifc Viewer 예시";

  const description = document.createElement("p");
  description.textContent =
    "That Open Components 구조를 따라 만든 기본 IFC 뷰어입니다.";

  const actions = document.createElement("section");

  const sampleButton = document.createElement("button");
  sampleButton.textContent = "샘플 IFC 불러오기";

  const fileLabel = document.createElement("label");
  fileLabel.textContent = "직접 IFC 파일 선택";

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".ifc";
  fileLabel.append(fileInput);

  actions.append(sampleButton, fileLabel);

  const statusSection = document.createElement("section");

  const status = document.createElement("p");
  status.textContent = "";

  const progress = document.createElement("progress");
  progress.max = 1;
  progress.value = 0;
  progress.hidden = true;

  statusSection.append(status, progress);

  const footer = document.createElement("p");
  footer.className = "footer-note";
  footer.innerHTML =
    '참고 문서: <a href="https://docs.thatopen.com/components/getting-started" target="_blank" rel="noreferrer">Getting started</a> · ' +
    '<a href="https://docs.thatopen.com/components/creating-components" target="_blank" rel="noreferrer">Creating components</a> · ' +
    '<a href="https://docs.thatopen.com/components/clean-components-guide" target="_blank" rel="noreferrer">Clean components</a>';

  root.append(title, description, actions, statusSection, footer);

  return {
    setBusy(active: boolean) {
      sampleButton.disabled = active;
      fileInput.disabled = active;
    },
    setStatus(message: string) {
      status.textContent = message;
    },
    setProgress(value: number | null) {
      if (value === null) {
        progress.hidden = true;
        progress.value = 0;
        return;
      }
      progress.hidden = false;
      progress.value = clamp(value);
    },
    onSample(handler: () => void) {
      sampleButton.addEventListener("click", handler);
    },
    onFile(handler: (file: File) => void | Promise<void>) {
      fileInput.addEventListener("change", async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        try {
          await handler(file);
        } finally {
          fileInput.value = "";
        }
      });
    }
  };
}

function clamp(value: number) {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

async function fetchIfc(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch IFC from ${url}`);
  }
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

async function readFile(file: File) {
  const arrayBuffer = await file.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

function extractProgress(state: unknown) {
  if (typeof state === "number") {
    return clamp(state);
  }

  if (typeof state === "object" && state) {
    const data = state as Record<string, unknown>;
    if (typeof data.ratio === "number") {
      return clamp(data.ratio);
    }
    if (typeof data.percentage === "number") {
      return clamp(data.percentage / 100);
    }
    if (
      typeof data.current === "number" &&
      typeof data.total === "number" &&
      data.total !== 0
    ) {
      return clamp(data.current / data.total);
    }
    if (
      typeof data.progress === "number" &&
      typeof data.max === "number" &&
      data.max !== 0
    ) {
      return clamp(data.progress / data.max);
    }
  }

  return undefined;
}
