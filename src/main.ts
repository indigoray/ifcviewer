import "./style.css";

import Stats from "stats.js";
import * as THREE from "three";
import * as BUI from "@thatopen/ui";
import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import * as CUI from "@thatopen/ui-obc";
import { PostproductionAspect } from "@thatopen/components-front";

type ViewerWorld = OBC.World<
  OBC.SimpleScene,
  OBC.OrthoPerspectiveCamera,
  OBF.PostproductionRenderer
>;

type ViewCubeElement = HTMLElement & {
  camera: THREE.Camera;
  updateOrientation: () => void;
};

type UiController = {
  setBusy(active: boolean): void;
  setStatus(message: string): void;
  setProgress(value: number | null): void;
  onSample(handler: (selectedFile: string) => void): void;
  onFile(handler: (file: File) => void | Promise<void>): void;
  updateModelsTab(elements: { modelsList: HTMLElement; loadBtn: HTMLElement }): void;
  updatePropertiesTab(propertiesTable: HTMLElement): void;
  updateSpatialTreeTab(spatialTree: HTMLElement): void;
};

type ToolbarMenuItem = {
  label: string;
  hint?: string;
  action: () => Promise<void> | void;
};

type ToolbarUpdater = {
  updateClassifier(items: ToolbarMenuItem[]): void;
  updateFinder(items: ToolbarMenuItem[]): void;
  updateViews(items: ToolbarMenuItem[]): void;
  refreshProjectionLabel(): void;
};

type ToolbarContext = {
  world: ViewerWorld;
  ui: UiController;
  hoverer: OBF.Hoverer;
  highlighter: OBF.Highlighter;
  postproduction: ReturnType<typeof getPostproduction>;
  hider: OBC.Hider;
  finder: OBC.ItemsFinder;
  views: OBC.Views;
  grid: OBC.SimpleGrid;
};

const SAMPLE_IFC_URL =
  "https://thatopen.github.io/engine_components/resources/ifc/school_str.ifc";

const processedModels = new Set<string>();
const classifierSelections = new Map<string, OBC.ModelIdMap>();
const finderQueryRegistry = new Map<string, string>();

void bootstrap().catch((error) => {
  console.error("Failed to start viewer", error);
});

async function bootstrap() {
  const viewerRoot = document.getElementById("viewer");
  const uiRoot = document.getElementById("ui");

  if (!(viewerRoot instanceof HTMLElement) || !(uiRoot instanceof HTMLElement)) {
    throw new Error("Viewer container not found");
  }

  BUI.Manager.init();
  CUI.Manager.init();

  const components = new OBC.Components();
  const world = await setupWorld(components, viewerRoot);
  setupViewCube(world, viewerRoot);
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

  const highlighter = components.get(OBF.Highlighter);
  await highlighter.setup({
    world,
    selectMaterialDefinition: {
      color: new THREE.Color("#37b26c"),
      opacity: 0.85,
      transparent: false,
      renderedFaces: 0
    }
  });

  const hoverer = components.get(OBF.Hoverer);
  hoverer.world = world;
  hoverer.enabled = true;
  hoverer.material = new THREE.MeshBasicMaterial({
    color: 0x4a90e2,
    transparent: true,
    opacity: 0.35,
    depthTest: false
  });

  const postproduction = getPostproduction(world);
  postproduction.enabled = false;
  const gridsComponent = components.get(OBC.Grids);
  const grid = gridsComponent.create(world);
  const views = components.get(OBC.Views);
  views.world = world;

  const classifier = components.get(OBC.Classifier);
  const hider = components.get(OBC.Hider);
  const finder = components.get(OBC.ItemsFinder);
  const raycasters = components.get(OBC.Raycasters);
  raycasters.get(world);

  const ui = buildUi(uiRoot);
  ui.setStatus("모델을 선택하거나 샘플을 불러와 주세요.");

  // ModelsList 컴포넌트 초기화
  const [modelsList] = CUI.tables.modelsList({
    components,
    actions: { download: true, dispose: true }
  });

  const [loadFragBtn] = CUI.buttons.loadFrag({ components });

  ui.updateModelsTab({
    modelsList: modelsList as unknown as HTMLElement,
    loadBtn: loadFragBtn as unknown as HTMLElement
  });

  // ItemsData (Properties) 컴포넌트 초기화
  const [propertiesTable, updatePropertiesTable] = CUI.tables.itemsData({
    components,
    modelIdMap: {}
  });

  propertiesTable.preserveStructureOnFilter = true;
  propertiesTable.indentationInText = false;
  propertiesTable.expanded = false;

  ui.updatePropertiesTab(propertiesTable as unknown as HTMLElement);

  // SpatialTree 컴포넌트 초기화
  const [spatialTree, updateSpatialTree] = CUI.tables.spatialTree({
    components,
    models: []
  });

  spatialTree.preserveStructureOnFilter = true;
  spatialTree.expanded = false;

  ui.updateSpatialTreeTab(spatialTree as unknown as HTMLElement);

  const toolbar = buildToolbar({
    world,
    ui,
    hoverer,
    highlighter,
    postproduction,
    grid,
    hider,
    finder,
    views
  });

  // 선택 변경 시 속성 테이블 업데이트 및 상태 업데이트
  highlighter.events.select.onHighlight.add(async (modelIdMap) => {
    const count = countSelection(modelIdMap);
    if (count > 0) {
      ui.setStatus(`선택된 요소 ${count.toLocaleString("ko-KR")}개`);
    }

    // Properties 탭 업데이트 - updatePropertiesTable 함수 사용
    updatePropertiesTable({ modelIdMap });
    
    // Wait for data to be loaded and rendered
    await delay(300);
    await expandPropertiesToLevel(propertiesTable as unknown as HTMLElement, 1);
  });

  highlighter.events.select.onClear.add(() => {
    ui.setStatus("선택이 비어 있습니다.");

    // Properties 탭 초기화
    updatePropertiesTable({ modelIdMap: {} });
  });

  ui.onSample((selectedFile: string) =>
    queue(async () => {
      const fileName = selectedFile.split('/').pop() || "IFC 파일";
      ui.setStatus(`${fileName}을 다운로드 중입니다.`);
      const buffer = await fetchIfc(selectedFile);
      await loadIfcBuffer(buffer, fileName.replace('.ifc', ''));
    })
  );

  ui.onFile((file) =>
    queue(async () => {
      ui.setStatus(`"${file.name}" 변환을 시작합니다.`);
      const buffer = await readFile(file);
      await loadIfcBuffer(buffer, file.name);
    })
  );

  window.addEventListener("beforeunload", () => {
    URL.revokeObjectURL(workerUrl);
  });

  let busy = false;

  async function queue(task: () => Promise<void>) {
    if (busy) return;
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
  }

  async function loadIfcBuffer(buffer: Uint8Array, label: string) {
    ui.setProgress(0);
    const model = await ifcLoader.load(buffer, false, label, {
      processData: {
        progressCallback: (state) => {
          const ratio = extractProgress(state);
          if (ratio !== undefined) {
            ui.setProgress(ratio);
            ui.setStatus(`${label} 변환 중... ${Math.round(ratio * 100)}%`);
          } else {
            ui.setStatus(`${label} 데이터를 준비 중입니다.`);
          }
        }
      }
    });

    ui.setProgress(null);
    ui.setStatus(`${label} 로딩이 완료되었습니다.`);
    
    // TODO: frag 파일로 저장 기능 구현 필요
    // @thatopen/components의 적절한 export 메서드를 찾아야 함
    
    await registerModelTools({
      model,
      world,
      toolbar,
      views,
      hider,
      classifier,
      finder,
      ui
    });
  }

  toolbar.refreshProjectionLabel();
}

async function setupWorld(
  components: OBC.Components,
  container: HTMLElement
): Promise<ViewerWorld> {
  const worlds = components.get(OBC.Worlds);
  const world = worlds.create<
    OBC.SimpleScene,
    OBC.OrthoPerspectiveCamera,
    OBF.PostproductionRenderer
  >();

  world.scene = new OBC.SimpleScene(components);
  world.scene.setup();
  world.scene.three.background = null;

  world.renderer = new OBF.PostproductionRenderer(components, container);
  world.camera = new OBC.OrthoPerspectiveCamera(components);
  await world.camera.controls.setLookAt(60, 35, 60, 0, 0, 0);

  components.init();

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

  world.onCameraChanged.add((camera) => {
    for (const [, model] of fragments.list) {
      model.useCamera(camera.three);
    }
    fragments.core.update(true);
  });

  fragments.list.onItemSet.add(({ value: model }) => {
    model.useCamera(world.camera.three);
    world.scene.three.add(model.object);
    fragments.core.update(true);
  });

  return workerUrl;
}

function buildUi(root: HTMLElement): UiController {
  root.innerHTML = "";

  const title = document.createElement("h1");
  title.textContent = "IFC Viewer";

  // 탭 헤더
  const tabHeader = document.createElement("div");
  tabHeader.className = "tab-header";

  const modelsTabBtn = document.createElement("button");
  modelsTabBtn.className = "tab-button active";
  modelsTabBtn.textContent = "Models";
  modelsTabBtn.dataset.tab = "models";

  const propertiesTabBtn = document.createElement("button");
  propertiesTabBtn.className = "tab-button";
  propertiesTabBtn.textContent = "Properties";
  propertiesTabBtn.dataset.tab = "properties";

  const spatialTreeTabBtn = document.createElement("button");
  spatialTreeTabBtn.className = "tab-button";
  spatialTreeTabBtn.textContent = "Spatial Tree";
  spatialTreeTabBtn.dataset.tab = "spatial-tree";

  tabHeader.append(modelsTabBtn, propertiesTabBtn, spatialTreeTabBtn);

  // 탭 컨텐츠 컨테이너
  const tabContents = document.createElement("div");
  tabContents.className = "tab-contents";

  // Models 탭
  const modelsTab = document.createElement("div");
  modelsTab.className = "tab-content active";
  modelsTab.dataset.tab = "models";

  const modelsSection = document.createElement("section");
  const modelsSectionTitle = document.createElement("h3");
  modelsSectionTitle.textContent = "샘플 모델 불러오기";

  // IFC 파일 선택 드롭다운
  const sampleContainer = document.createElement("div");
  sampleContainer.style.display = "flex";
  sampleContainer.style.gap = "0.5rem";
  sampleContainer.style.marginBottom = "1rem";
  
  const ifcSelect = document.createElement("select");
  ifcSelect.style.flex = "1";
  const ifcFiles = [
    { value: "/IFC/01.ifc", label: "01.ifc" },
    { value: "/IFC/02.ifc", label: "02.ifc" },
    { value: "/IFC/03.ifc", label: "03.ifc" },
    { value: "/IFC/04.ifc", label: "04.ifc" },
    { value: "/IFC/05.ifc", label: "05.ifc" }
  ];
  ifcFiles.forEach(file => {
    const option = document.createElement("option");
    option.value = file.value;
    option.textContent = file.label;
    ifcSelect.appendChild(option);
  });
  
  const sampleButton = document.createElement("button");
  sampleButton.textContent = "Load";
  
  sampleContainer.append(ifcSelect, sampleButton);

  const fileLabel = document.createElement("label");
  fileLabel.textContent = "직접 IFC 파일 선택";

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".ifc";
  fileLabel.append(fileInput);

  modelsSection.append(modelsSectionTitle, sampleContainer, fileLabel);

  const fragmentSection = document.createElement("section");
  const fragmentTitle = document.createElement("h3");
  fragmentTitle.textContent = "Fragment 파일 불러오기";
  fragmentSection.append(fragmentTitle);

  const modelsListSection = document.createElement("section");
  const modelsListTitle = document.createElement("h3");
  modelsListTitle.textContent = "로딩된 모델";
  modelsListSection.append(modelsListTitle);

  modelsTab.append(modelsSection, fragmentSection, modelsListSection);

  // Properties 탭
  const propertiesTab = document.createElement("div");
  propertiesTab.className = "tab-content";
  propertiesTab.dataset.tab = "properties";

  const propertiesSection = document.createElement("section");
  const propertiesTitle = document.createElement("h3");
  propertiesTitle.textContent = "요소 속성";
  const propertiesMessage = document.createElement("p");
  propertiesMessage.className = "empty-message";
  propertiesMessage.textContent = "요소를 선택하면 속성이 표시됩니다.";
  propertiesSection.append(propertiesTitle, propertiesMessage);

  propertiesTab.append(propertiesSection);

  // Spatial Tree 탭
  const spatialTreeTab = document.createElement("div");
  spatialTreeTab.className = "tab-content";
  spatialTreeTab.dataset.tab = "spatial-tree";

  const spatialTreeSection = document.createElement("section");
  const spatialTreeTitle = document.createElement("h3");
  spatialTreeTitle.textContent = "공간 구조";
  const spatialTreeControls = document.createElement("div");
  spatialTreeControls.className = "spatial-tree-controls";
  const expandAllButton = document.createElement("button");
  expandAllButton.title = "Expand All";
  expandAllButton.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M5 4h14a1 1 0 0 1 .993.883L20 5v6h-2V6H6v12h12v-5h2v6a1 1 0 0 1-.883.993L19 20H5a1 1 0 0 1-.993-.883L4 19V5a1 1 0 0 1 .883-.993L5 4zm7 3a1 1 0 0 1 .993.883L13 8v2h2a1 1 0 0 1 .117 1.993L15 12h-2v2a1 1 0 0 1-1.993.117L11 14v-2H9a1 1 0 0 1-.117-1.993L9 10h2V8a1 1 0 0 1 1-1z"/></svg>`;
  const expandStoreyButton = document.createElement("button");
  expandStoreyButton.title = "Expand To Storeys";
  expandStoreyButton.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M5 3h14a1 1 0 0 1 .993.883L20 4v16a1 1 0 0 1-.883.993L19 21H5a1 1 0 0 1-.993-.883L4 20V4a1 1 0 0 1 .883-.993L5 3h14H5zm1 2v2h12V5H6zm0 4v2h12V9H6zm0 4v2h7a1 1 0 0 1 .117 1.993L13 17H6v3h12v-3h-3a1 1 0 1 1 0-2h3v-2H6z"/></svg>`;
  const collapseAllButton = document.createElement("button");
  collapseAllButton.title = "Collapse All";
  collapseAllButton.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M5 4h14a1 1 0 0 1 .993.883L20 5v6h-2V6H6v12h12v-5h2v6a1 1 0 0 1-.883.993L19 20H5a1 1 0 0 1-.993-.883L4 19V5a1 1 0 0 1 .883-.993L5 4zm7 5a1 1 0 0 1 .993.883L13 10v2h2a1 1 0 0 1 .117 1.993L15 14h-6a1 1 0 0 1-.117-1.993L9 12h2v-2a1 1 0 0 1 1-1z"/></svg>`;
  spatialTreeControls.append(expandAllButton, expandStoreyButton, collapseAllButton);
  const spatialTreeMessage = document.createElement("p");
  spatialTreeMessage.className = "empty-message";
  spatialTreeMessage.textContent = "모델을 불러오면 공간 구조가 표시됩니다.";
  const spatialTreeContainer = document.createElement("div");
  spatialTreeContainer.className = "spatial-tree-container";
  spatialTreeSection.append(spatialTreeTitle, spatialTreeControls, spatialTreeMessage, spatialTreeContainer);

  spatialTreeTab.append(spatialTreeSection);

  tabContents.append(modelsTab, propertiesTab, spatialTreeTab);

  // 상태 표시 영역
  const statusSection = document.createElement("section");
  statusSection.className = "status-section";

  const status = document.createElement("p");
  status.textContent = "";

  const progress = document.createElement("progress");
  progress.max = 1;
  progress.value = 0;
  progress.hidden = true;

  statusSection.append(status, progress);

  root.append(title, tabHeader, tabContents, statusSection);

  // 탭 전환 이벤트
  const tabButtons = [modelsTabBtn, propertiesTabBtn, spatialTreeTabBtn];
  const tabs = [modelsTab, propertiesTab, spatialTreeTab];

  let spatialTreeElement: HTMLElement | null = null;

  const setTreeControlsEnabled = (enabled: boolean) => {
    expandAllButton.disabled = !enabled;
    expandStoreyButton.disabled = !enabled;
    collapseAllButton.disabled = !enabled;
  };

  setTreeControlsEnabled(false);

  expandAllButton.addEventListener("click", () => {
    if (!spatialTreeElement) return;
    void expandAllInSpatialTree(spatialTreeElement);
  });

  expandStoreyButton.addEventListener("click", () => {
    if (!spatialTreeElement) return;

    if (expandStoreyButton.disabled) return;
    expandStoreyButton.disabled = true;

    void expandToStoreyLevel(spatialTreeElement).finally(() => {
      expandStoreyButton.disabled = false;
    });
  });

  collapseAllButton.addEventListener("click", () => {
    if (!spatialTreeElement) return;
    void collapseAllInSpatialTree(spatialTreeElement);
  });

  tabButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const targetTab = btn.dataset.tab;
      
      tabButtons.forEach(b => b.classList.remove("active"));
      tabs.forEach(t => t.classList.remove("active"));

      btn.classList.add("active");
      const contentTab = tabs.find(t => t.dataset.tab === targetTab);
      if (contentTab) {
        contentTab.classList.add("active");
      }
    });
  });

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
    onSample(handler: (selectedFile: string) => void) {
      sampleButton.addEventListener("click", () => {
        handler(ifcSelect.value);
      });
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
    },
    updateModelsTab(elements: { modelsList: HTMLElement; loadBtn: HTMLElement }) {
      // Fragment 버튼 추가
      const fragmentContainer = fragmentSection.querySelector("div") || document.createElement("div");
      if (!fragmentContainer.parentElement) {
        fragmentSection.append(fragmentContainer);
      }
      fragmentContainer.innerHTML = "";
      fragmentContainer.append(elements.loadBtn);

      // Models 리스트 추가
      const modelsListContainer = modelsListSection.querySelector("div") || document.createElement("div");
      if (!modelsListContainer.parentElement) {
        modelsListSection.append(modelsListContainer);
      }
      modelsListContainer.innerHTML = "";
      modelsListContainer.append(elements.modelsList);
    },
    updatePropertiesTab(propertiesTable: HTMLElement) {
      propertiesSection.innerHTML = "";
      propertiesSection.append(propertiesTitle, propertiesTable);
    },
    updateSpatialTreeTab(spatialTree: HTMLElement) {
      spatialTreeContainer.innerHTML = "";
      spatialTreeContainer.append(spatialTree);
      spatialTreeMessage.style.display = "none";
      spatialTreeElement = spatialTree;
      setTreeControlsEnabled(true);
    }
  };
}

function buildToolbar(context: ToolbarContext): ToolbarUpdater {
  const { world, ui, hoverer, highlighter, postproduction, hider, finder, views, grid } =
    context;

  const toolbar = document.createElement("div");
  toolbar.id = "toolbar";

  const popup = document.createElement("div");
  popup.id = "toolbar-popup";

  const popupTitle = document.createElement("h2");
  const popupList = document.createElement("div");
  popupList.className = "toolbar-popup-list";
  const popupMessage = document.createElement("p");
  popupMessage.className = "toolbar-message";

  popup.append(popupTitle, popupList, popupMessage);

  document.body.append(toolbar, popup);

  let currentMenu: "classifier" | "finder" | "views" | null = null;
  let classifierItems: ToolbarMenuItem[] = [];
  let finderItems: ToolbarMenuItem[] = [];
  let viewItems: ToolbarMenuItem[] = [];

  views.list.onItemSet.add(() => {
    viewItems = buildViewItems(views, ui);
    if (currentMenu === "views") {
      renderMenu(viewItems, "저장된 뷰", "모델을 불러와 2D 뷰를 생성하면 나타납니다.");
    }
  });

  views.list.onItemDeleted.add(() => {
    viewItems = buildViewItems(views, ui);
    if (currentMenu === "views") {
      renderMenu(viewItems, "저장된 뷰", "모델을 불러와 2D 뷰를 생성하면 나타납니다.");
    }
  });

  views.list.onCleared?.add(() => {
    viewItems = [];
    if (currentMenu === "views") {
      renderMenu(viewItems, "저장된 뷰", "모델을 불러와 2D 뷰를 생성하면 나타납니다.");
    }
  });

  function closeMenu() {
    currentMenu = null;
    popup.classList.remove("visible");
  }

  function renderMenu(items: ToolbarMenuItem[], title: string, emptyHint: string) {
    if (currentMenu === null) {
      closeMenu();
      return;
    }
    popupTitle.textContent = title;
    popupList.innerHTML = "";

    if (items.length === 0) {
      popupMessage.textContent = emptyHint;
    } else {
      popupMessage.textContent = "";
      for (const item of items) {
        const button = document.createElement("button");
        button.className = "toolbar-button secondary";
        button.textContent = item.label;
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            await item.action();
            closeMenu();
          } finally {
            button.disabled = false;
          }
        });
        if (item.hint) {
          button.title = item.hint;
        }
        popupList.append(button);
      }
    }
  }

  function toggleMenu(
    menu: "classifier" | "finder" | "views",
    title: string,
    emptyHint: string,
    items: ToolbarMenuItem[]
  ) {
    if (currentMenu === menu && popup.classList.contains("visible")) {
      closeMenu();
      return;
    }
    currentMenu = menu;
    popup.classList.add("visible");
    renderMenu(items, title, emptyHint);
  }

  const clearSelectionBtn = document.createElement("button");
  clearSelectionBtn.className = "toolbar-button";
  clearSelectionBtn.title = "선택 초기화";
  clearSelectionBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M5 5h14v2H5V5zm2 4h10l-1.5 11h-7L7 9zm4-6a1 1 0 0 1 1 1v1h-2V4a1 1 0 0 1 1-1z"/></svg>`;
  clearSelectionBtn.addEventListener("click", async () => {
    await highlighter.clear("select");
    ui.setStatus("선택을 초기화했습니다.");
  });
  toolbar.append(clearSelectionBtn);

  const isolateBtn = document.createElement("button");
  isolateBtn.className = "toolbar-button";
  isolateBtn.title = "선택 격리";
  isolateBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M4 4h16v4h-2V6H6v12h12v-2h2v4H4V4zm8 3a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2.5A2.5 2.5 0 1 0 12 15a2.5 2.5 0 0 0 0-5z"/></svg>`;
  isolateBtn.addEventListener("click", async () => {
    const selection = highlighter.selection.select;
    if (isSelectionEmpty(selection)) {
      ui.setStatus("격리할 선택이 없습니다.");
      return;
    }
    await hider.isolate(cloneModelIdMap(selection));
    ui.setStatus("선택한 요소만 표시 중입니다.");
  });
  toolbar.append(isolateBtn);

  const resetVisibilityBtn = document.createElement("button");
  resetVisibilityBtn.className = "toolbar-button";
  resetVisibilityBtn.title = "전체 표시";
  resetVisibilityBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6zm9 4a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0-6.5A2.5 2.5 0 1 1 12 15a2.5 2.5 0 0 1 0-5z"/></svg>`;
  resetVisibilityBtn.addEventListener("click", async () => {
    await hider.set(true);
    ui.setStatus("모델 전체를 다시 표시했습니다.");
  });
  toolbar.append(resetVisibilityBtn);

  const hoverBtn = document.createElement("button");
  hoverBtn.className = "toolbar-button";
  hoverBtn.title = "호버 강조";
  hoverBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 2l2.09 6.26H20l-5.17 3.76L16.18 18 12 14.27 7.82 18 9.17 12.02 4 8.26h5.91L12 2z"/></svg>`;
  hoverBtn.classList.toggle("active", hoverer.enabled);
  hoverBtn.addEventListener("click", () => {
    hoverer.enabled = !hoverer.enabled;
    hoverBtn.classList.toggle("active", hoverer.enabled);
    ui.setStatus(
      hoverer.enabled ? "호버 강조를 켰습니다." : "호버 강조를 끄고 기본 상태로 전환했습니다."
    );
  });
  toolbar.append(hoverBtn);

  const postBtn = document.createElement("button");
  postBtn.className = "toolbar-button";
  postBtn.title = "후처리";
  postBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 3a9 9 0 0 1 9 9h-2a7 7 0 1 0-7 7v-3l5 4-5 4v-3a9 9 0 0 1 0-18z"/></svg>`;
  postBtn.classList.toggle("active", postproduction.enabled);
  postBtn.addEventListener("click", () => {
    postproduction.enabled = !postproduction.enabled;
    postBtn.classList.toggle("active", postproduction.enabled);
    console.log("[DEBUG] Postproduction enabled:", postproduction.enabled);
    console.log("[DEBUG] Postproduction state:", {
      enabled: postproduction.enabled,
      outlinesEnabled: postproduction.outlinesEnabled,
      style: postproduction.style
    });
    ui.setStatus(
      postproduction.enabled
        ? "후처리 효과를 활성화했습니다."
        : "후처리 효과를 비활성화했습니다."
    );
  });
  toolbar.append(postBtn);

  const gridBtn = document.createElement("button");
  gridBtn.className = "toolbar-button";
  const updateGridButtonState = () => {
    gridBtn.classList.toggle("active", grid.visible);
    gridBtn.title = grid.visible ? "그리드 숨기기" : "그리드 표시";
  };
  gridBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5zm2 1v12h12V6H6zm3 0h2v12H9V6zm6 0h2v12h-2V6zM6 11h12v2H6v-2z"/></svg>`;
  updateGridButtonState();
  gridBtn.addEventListener("click", () => {
    grid.visible = !grid.visible;
    updateGridButtonState();
    ui.setStatus(grid.visible ? "그리드를 표시합니다." : "그리드를 숨겼습니다.");
  });
  toolbar.append(gridBtn);

  const classifierBtn = document.createElement("button");
  classifierBtn.className = "toolbar-button";
  classifierBtn.title = "분류 보기";
  classifierBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M4 5h16v2H4V5zm0 6h10v2H4v-2zm0 6h16v2H4v-2z"/></svg>`;
  classifierBtn.addEventListener("click", () => {
    toggleMenu("classifier", "분류 그룹", "모델을 불러오면 자동으로 그룹이 준비됩니다.", classifierItems);
  });
  toolbar.append(classifierBtn);

  const finderBtn = document.createElement("button");
  finderBtn.className = "toolbar-button";
  finderBtn.title = "빠른 찾기";
  finderBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm5.707 10.293L20.414 20l-1.414 1.414-3.707-3.707 1.414-1.414z"/></svg>`;
  finderBtn.addEventListener("click", () => {
    toggleMenu("finder", "즐겨찾는 검색", "모델을 불러오면 사용할 수 있습니다.", finderItems);
  });
  toolbar.append(finderBtn);

  const projectionBtn = document.createElement("button");
  projectionBtn.className = "toolbar-button";
  projectionBtn.title = "투영 전환";
  projectionBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M4 6h16v2H4V6zm0 5h10v2H4v-2zm0 5h16v2H4v-2z"/></svg>`;
  projectionBtn.addEventListener("click", () => {
    const projection = world.camera.projection.current;
    const next = projection === "Perspective" ? "Orthographic" : "Perspective";
    if (next === "Orthographic" && world.camera.mode.id === "FirstPerson") {
      ui.setStatus("직교 투영은 1인칭 모드에서는 사용할 수 없습니다.");
      return;
    }
    world.camera.projection.set(next);
    ui.setStatus(`카메라 투영을 ${next === "Perspective" ? "원근" : "직교"}로 변경했습니다.`);
    updateProjectionLabel();
  });
  toolbar.append(projectionBtn);

  const cameraModeBtn = document.createElement("button");
  cameraModeBtn.className = "toolbar-button";
  cameraModeBtn.title = "카메라 모드: Orbit";
  cameraModeBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 4a8 8 0 1 1-6.32 12.9l-1.6.8A10 10 0 1 0 12 2v2zm0 3a5 5 0 1 1 0 10 5 5 0 0 1 0-10z"/></svg>`;
  cameraModeBtn.addEventListener("click", () => {
    const current = world.camera.mode.id;
    const next = current === "Orbit" ? "Plan" : "Orbit";
    world.camera.set(next);
    cameraModeBtn.title = `카메라 모드: ${next}`;
    ui.setStatus(`${next} 모드로 전환했습니다.`);
  });
  toolbar.append(cameraModeBtn);

  const viewsBtn = document.createElement("button");
  viewsBtn.className = "toolbar-button";
  viewsBtn.title = "뷰 전환";
  viewsBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M4 5h6v6H4V5zm10 0h6v6h-6V5zM4 13h6v6H4v-6zm10 0h6v6h-6v-6z"/></svg>`;
  viewsBtn.addEventListener("click", () => {
    toggleMenu("views", "저장된 뷰", "모델을 불러와 2D 뷰를 생성하면 나타납니다.", viewItems);
  });
  toolbar.append(viewsBtn);

  const closeViewBtn = document.createElement("button");
  closeViewBtn.className = "toolbar-button";
  closeViewBtn.title = "뷰 닫기";
  closeViewBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M6.225 4.811 7.64 3.397 12 7.757l4.36-4.36 1.414 1.414L13.414 9.17l4.36 4.36-1.414 1.414L12 10.586l-4.36 4.36-1.414-1.414 4.36-4.36-4.36-4.36z"/></svg>`;
  closeViewBtn.addEventListener("click", () => {
    views.close();
    ui.setStatus("활성 뷰를 닫았습니다.");
  });
  toolbar.append(closeViewBtn);

  document.addEventListener("click", (event) => {
    if (
      popup.contains(event.target as Node) ||
      toolbar.contains(event.target as Node)
    ) {
      return;
    }
    closeMenu();
  });

  function updateProjectionLabel() {
    const projection = world.camera.projection.current;
    projectionBtn.textContent =
      projection === "Perspective" ? "투영: 원근" : "투영: 직교";
  }

  return {
    updateClassifier(items) {
      classifierItems = items;
      if (currentMenu === "classifier") {
        renderMenu(classifierItems, "분류 그룹", "모델을 불러오면 자동으로 그룹이 준비됩니다.");
      }
    },
    updateFinder(items) {
      finderItems = items;
      if (currentMenu === "finder") {
        renderMenu(finderItems, "즐겨찾는 검색", "모델을 불러오면 사용할 수 있습니다.");
      }
    },
    updateViews(items) {
      viewItems = items;
      if (currentMenu === "views") {
        renderMenu(viewItems, "저장된 뷰", "모델을 불러와 2D 뷰를 생성하면 나타납니다.");
      }
    },
    refreshProjectionLabel: updateProjectionLabel
  };
}

function setupViewCube(world: ViewerWorld, container: HTMLElement) {
  const wrapper = document.createElement("div");
  wrapper.className = "viewcube-wrapper";

  const viewCube = document.createElement("bim-view-cube") as ViewCubeElement;
  viewCube.camera = world.camera.three;
  wrapper.append(viewCube);
  container.append(wrapper);

  let activeControls = world.camera.controls;

  const syncOrientation = () => {
    if (typeof viewCube.updateOrientation === "function") {
      viewCube.updateOrientation();
    }
  };

  activeControls.addEventListener("update", syncOrientation);

  world.onCameraChanged.add((camera) => {
    activeControls.removeEventListener("update", syncOrientation);
    activeControls = camera.controls;
    viewCube.camera = camera.three;
    syncOrientation();
    activeControls.addEventListener("update", syncOrientation);
  });

  // 올바른 이벤트 이름 사용: frontclick, backclick 등
  viewCube.addEventListener("frontclick", () => {
    world.camera.controls.setLookAt(0, 10, 50, 0, 0, 0, true);
  });

  viewCube.addEventListener("backclick", () => {
    world.camera.controls.setLookAt(0, 10, -50, 0, 0, 0, true);
  });

  viewCube.addEventListener("leftclick", () => {
    world.camera.controls.setLookAt(-50, 10, 0, 0, 0, 0, true);
  });

  viewCube.addEventListener("rightclick", () => {
    world.camera.controls.setLookAt(50, 10, 0, 0, 0, 0, true);
  });

  viewCube.addEventListener("topclick", () => {
    world.camera.controls.setLookAt(0, 50, 0, 0, 0, 0, true);
  });

  viewCube.addEventListener("bottomclick", () => {
    world.camera.controls.setLookAt(0, -50, 0, 0, 0, 0, true);
  });
}

async function registerModelTools(params: {
  model: OBC.FragmentsGroup;
  world: ViewerWorld;
  toolbar: ToolbarUpdater;
  views: OBC.Views;
  hider: OBC.Hider;
  classifier: OBC.Classifier;
  finder: OBC.ItemsFinder;
  ui: UiController;
}) {
  const { model, world, toolbar, views, hider, classifier, finder, ui } = params;
  const modelId = model.modelId;
  if (processedModels.has(modelId)) return;
  processedModels.add(modelId);

  const categoryGroups: Array<{
    label: string;
    categories: RegExp[];
  }> = [
    { label: "구조 부재", categories: [/BEAM/i, /COLUMN/i, /SLAB/i, /FOOTING/i] },
    { label: "외벽과 창호", categories: [/WALL/i, /WINDOW/i, /DOOR/i] },
    { label: "지붕 및 상부", categories: [/ROOF/i, /SLAB/i] }
  ];

  for (const group of categoryGroups) {
    const items = await model.getItemsOfCategories(group.categories);
    const ids = Object.values(items).flat();
    if (ids.length === 0) continue;
    const map: OBC.ModelIdMap = {
      [modelId]: new Set(ids)
    };
    const existing = classifierSelections.get(group.label);
    if (existing) {
      mergeModelIdMap(existing, map);
    } else {
      classifierSelections.set(group.label, map);
    }
    const groupData = classifier.getGroupData("기본 분류", group.label);
    mergeModelIdMap(groupData.map, map);
  }

  const classifierItems: ToolbarMenuItem[] = [...classifierSelections.entries()].map(
    ([label, selection]) => ({
      label,
      action: async () => {
        await hider.isolate(cloneModelIdMap(selection));
        ui.setStatus(`${label} 그룹만 표시했습니다.`);
      }
    })
  );
  toolbar.updateClassifier(classifierItems);

  ensureFinderQueries(finder);
  const finderItems = [...finderQueryRegistry.entries()].map(([label, queryName]) => ({
    label,
    action: async () => {
      const query = finder.list.get(queryName);
      if (!query) return;
      const result = await query.test();
      if (isSelectionEmpty(result)) {
        ui.setStatus(`${label} 결과가 없습니다.`);
        return;
      }
      await hider.isolate(result);
      ui.setStatus(`${label} 결과를 격리했습니다.`);
    }
  }));
  toolbar.updateFinder(finderItems);

  await views.createFromIfcStoreys({
    modelIds: [new RegExp(`^${escapeRegExp(modelId)}$`, "i")],
    world
  });

  toolbar.updateViews(buildViewItems(views, ui));
}

function buildViewItems(views: OBC.Views, ui: UiController): ToolbarMenuItem[] {
  return [...views.list.keys()].map((id) => ({
    label: id,
    action: () => {
      views.open(id);
      ui.setStatus(`${id} 뷰를 열었습니다.`);
    }
  }));
}

function ensureFinderQueries(finder: OBC.ItemsFinder) {
  const definitions: Array<{
    label: string;
    name: string;
    config: Parameters<OBC.ItemsFinder["create"]>[1];
  }> = [
    {
      label: "모든 벽",
      name: "Query::AllWalls",
      config: [{ categories: [/WALL/i] }]
    },
    {
      label: "문과 창",
      name: "Query::DoorsAndWindows",
      config: [{ categories: [/DOOR/i, /WINDOW/i] }]
    },
    {
      label: "기둥과 보",
      name: "Query::ColumnsBeams",
      config: [{ categories: [/COLUMN/i, /BEAM/i] }]
    }
  ];

  for (const def of definitions) {
    if (!finder.list.has(def.name)) {
      finder.create(def.name, def.config);
    }
    finderQueryRegistry.set(def.label, def.name);
  }
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

function clamp(value: number) {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function isSelectionEmpty(map: OBC.ModelIdMap) {
  return Object.values(map).every((set) => set.size === 0);
}

function countSelection(map: OBC.ModelIdMap) {
  let total = 0;
  for (const set of Object.values(map)) {
    total += set.size;
  }
  return total;
}

function cloneModelIdMap(map: OBC.ModelIdMap): OBC.ModelIdMap {
  const clone: OBC.ModelIdMap = {};
  for (const [modelId, ids] of Object.entries(map)) {
    clone[modelId] = new Set(ids);
  }
  return clone;
}

function mergeModelIdMap(target: OBC.ModelIdMap, addition: OBC.ModelIdMap) {
  for (const [modelId, ids] of Object.entries(addition)) {
    const current = target[modelId] ?? new Set<number>();
    for (const id of ids) {
      current.add(id);
    }
    target[modelId] = current;
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getPostproduction(world: ViewerWorld) {
  const post = world.renderer.postproduction;
  post.enabled = true;
  post.outlinesEnabled = true;
  post.style = PostproductionAspect.COLOR_SHADOWS;
  return post;
}

/**
 * Expands properties table to specified depth level efficiently.
 * Only toggles individual groups without using global expanded property.
 * @param tableElement - The properties table element
 * @param maxDepth - Maximum depth to expand (0=root only, 1=first level, 2=second level, etc.)
 */
async function expandPropertiesToLevel(tableElement: HTMLElement, maxDepth: number) {
  const table = tableElement.tagName?.toLowerCase() === 'bim-table' 
    ? tableElement 
    : findTableElement(tableElement);
  
  if (!table) {
    return;
  }

  const tableComponent = table as any;
  
  // Wait for table to have data
  console.log('[Props] Waiting for table data...');
  let attempts = 0;
  while ((!tableComponent.data || tableComponent.data.length === 0) && attempts < 50) {
    await delay(100);
    attempts++;
  }
  
  if (!tableComponent.data || tableComponent.data.length === 0) {
    console.log('[Props] No data in table after waiting');
    return;
  }
  
  console.log('[Props] Table has data:', tableComponent.data.length, 'items');
  
  // Expand to render DOM (and keep it expanded)
  console.log('[Props] Setting table.expanded = true...');
  tableComponent.expanded = true;
  await waitForElementUpdate(table);
  await delay(300);
  
  const shadowRoot = table.shadowRoot;
  if (!shadowRoot) {
    return;
  }

  const tableChildren = shadowRoot.querySelector('bim-table-children');
  if (!tableChildren) {
    console.log('[Props] No tableChildren found');
    return;
  }

  console.log('[Props] tableChildren found, children.length:', tableChildren.children.length);
  
  // Check all groups  
  const allGroups = Array.from(tableChildren.querySelectorAll('bim-table-group')) as HTMLElement[];
  console.log('[Props] All bim-table-group elements found:', allGroups.length);
  
  // Now manually collapse groups beyond maxDepth
  console.log('[Props] Manually collapsing groups beyond depth', maxDepth);

  // Get direct child groups from tableChildren (they're in light DOM)
  const getDirectGroups = (container: Element): HTMLElement[] => {
    // Groups are rendered in light DOM, not shadow DOM
    const groups = Array.from(container.querySelectorAll(':scope > bim-table-group')) as HTMLElement[];
    console.log(`[Props] getDirectGroups found ${groups.length} groups in`, container.tagName);
    
    // Also try without :scope
    const groups2 = Array.from(container.querySelectorAll('bim-table-group'));
    console.log(`[Props] Without :scope found ${groups2.length} groups`);
    
    // Check direct children
    const directChildren = Array.from(container.children);
    console.log(`[Props] Direct children count: ${directChildren.length}`);
    directChildren.forEach((child, i) => {
      console.log(`[Props] Child ${i}: ${child.tagName}`);
    });
    
    return groups;
  };

  // Helper to get depth of a group
  const getGroupDepth = (group: HTMLElement): number => {
    let depth = -1; // Start at -1 because tableChildren itself is depth 0
    let current: HTMLElement | null = group;
    while (current) {
      if (current.tagName?.toLowerCase() === 'bim-table-children') {
        depth++;
      }
      // Navigate through shadow DOM boundaries
      const host = (current.getRootNode() as ShadowRoot)?.host;
      current = host ? host.parentElement : current.parentElement;
    }
    return depth;
  };
  
  // Collapse all groups beyond maxDepth
  for (const group of allGroups) {
    const depth = getGroupDepth(group);
    const groupElement = group as any;
    
    console.log(`[Props] Group depth=${depth}, childrenHidden=${groupElement.childrenHidden}`);
    
    if (depth > maxDepth && typeof groupElement.toggleChildren === 'function') {
      if (!groupElement.childrenHidden) {
        console.log(`[Props] Collapsing group at depth ${depth}`);
        groupElement.toggleChildren(false);
      }
    }
  }
  
  console.log('[Props] Expansion complete');
}

/**
 * Expands spatial tree to building storey level efficiently.
 * Only toggles individual groups without using global expanded property.
 */
async function expandToStoreyLevel(tableElement: HTMLElement) {
  const table = tableElement.tagName?.toLowerCase() === 'bim-table' 
    ? tableElement 
    : findTableElement(tableElement);
  
  if (!table) {
    return;
  }

  const tableComponent = table as any;
  
  // Wait for table to have data
  console.log('[Spatial] Waiting for table data...');
  let attempts = 0;
  while ((!tableComponent.data || tableComponent.data.length === 0) && attempts < 50) {
    await delay(100);
    attempts++;
  }
  
  if (!tableComponent.data || tableComponent.data.length === 0) {
    console.log('[Spatial] No data in table after waiting');
    return;
  }
  
  console.log('[Spatial] Table has data:', tableComponent.data.length, 'items');
  
  // Expand to render DOM (and keep it expanded)
  console.log('[Spatial] Setting table.expanded = true...');
  tableComponent.expanded = true;
  await waitForElementUpdate(table);
  await delay(300);
  
  const shadowRoot = table.shadowRoot;
  if (!shadowRoot) {
    return;
  }

  const tableChildren = shadowRoot.querySelector('bim-table-children');
  if (!tableChildren) {
    console.log('[Spatial] No tableChildren found');
    return;
  }

  // Find all groups recursively
  const findAllGroups = (root: Element | ShadowRoot): HTMLElement[] => {
    const groups: HTMLElement[] = [];
    groups.push(...Array.from(root.querySelectorAll('bim-table-group')) as HTMLElement[]);
    for (const el of Array.from(root.querySelectorAll('*'))) {
      const shadow = (el as any).shadowRoot;
      if (shadow) groups.push(...findAllGroups(shadow));
    }
    return groups;
  };

  const allGroups = [
    ...findAllGroups(tableChildren),
    ...((tableChildren as any).shadowRoot ? findAllGroups((tableChildren as any).shadowRoot) : [])
  ];
  
  console.log('[Spatial] All bim-table-group elements found:', allGroups.length);

  // Get direct child groups from container (they're in light DOM)
  const getDirectGroups = (container: Element): HTMLElement[] => {
    // Groups are rendered in light DOM, not shadow DOM
    const groups = Array.from(container.querySelectorAll(':scope > bim-table-group')) as HTMLElement[];
    
    // Check direct children
    const directChildren = Array.from(container.children);
    console.log(`[Spatial] Direct children count: ${directChildren.length}, groups: ${groups.length}`);
    
    return groups;
  };

  // Find and collapse children of storey instances
  let storeyFound = false;
  for (let i = 0; i < allGroups.length; i++) {
    const group = allGroups[i] as any;
    const actualData = group.data?.data || group.data;
    const name = actualData?.Name || actualData?.name || '';
    
    console.log(`[Spatial] Group ${i}: ${name}`);
    
    if (name === 'IFCBUILDINGSTOREY') {
      storeyFound = true;
      console.log('[Spatial] Found IFCBUILDINGSTOREY at index', i);
      continue;
    }
    
    // After finding IFCBUILDINGSTOREY, collapse children of storey instances
    if (storeyFound && !name.startsWith('IFC')) {
      if (typeof group.toggleChildren === 'function' && !group.childrenHidden) {
        console.log(`[Spatial] Collapsing storey instance: ${name}`);
        group.toggleChildren(false);
      }
    }
    
    // Stop when we hit another IFC type after storey instances
    if (storeyFound && name.startsWith('IFC') && name !== 'IFCBUILDINGSTOREY') {
      console.log('[Spatial] Reached next IFC type, stopping');
      break;
    }
  }
  
  console.log('[Spatial] Expansion complete');
}

function findTableElement(element: any): HTMLElement | null {
  if (element && typeof element === 'object' && 'tagName' in element && element.tagName?.toLowerCase() === "bim-table") {
    return element as HTMLElement;
  }

  if (element && typeof element === 'object' && 'querySelector' in element) {
    const nested = (element as HTMLElement).querySelector("bim-table");
    if (nested) return nested as HTMLElement;
  }

  if (element && typeof element === 'object' && 'shadowRoot' in element) {
    const shadowTable = (element as any).shadowRoot?.querySelector("bim-table");
    if (shadowTable) return shadowTable as HTMLElement;
  }

  return null;
}

async function waitForElementUpdate(element: any) {
  try {
    const updateComplete = element?.updateComplete;
    if (updateComplete instanceof Promise) await updateComplete;
  } catch (error) {
    // Silently ignore update errors
  }
  await delay(0);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function expandAllInSpatialTree(tableElement: HTMLElement) {
  const table = findTableElement(tableElement);
  if (!table) return;
  
  (table as any).expanded = false;
  await waitForElementUpdate(table);
  await delay(100);
  
  (table as any).expanded = true;
  await waitForElementUpdate(table);
}

async function collapseAllInSpatialTree(tableElement: HTMLElement) {
  const table = findTableElement(tableElement);
  if (!table) return;
  
  (table as any).expanded = false;
  await waitForElementUpdate(table);
}
