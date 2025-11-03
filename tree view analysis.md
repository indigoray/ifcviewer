# @thatopen/ui bim-table 컴포넌트 분석

## 컴포넌트 계층 구조

```
bim-table (Table)
└─ shadowRoot
   └─ bim-table-children (TableChildren)
      └─ shadowRoot  ⚠️ CRITICAL: tableChildren도 shadowRoot를 가짐!
         ├─ bim-table-group (TableGroup)
         │  └─ shadowRoot
         │     ├─ bim-table-row (TableRow)
         │     └─ bim-table-children (자식이 있을 경우)
         │        └─ shadowRoot  ⚠️ 자식 tableChildren도 shadowRoot를 가짐!
         │           ├─ bim-table-group
         │           │  └─ shadowRoot
         │           │     └─ ...
         │           └─ bim-table-group
         ├─ bim-table-group
         └─ bim-table-group
```

## 주요 컴포넌트 분석

### 1. Table (`bim-table`)
**파일**: `engine_ui-components/packages/core/src/components/Table/index.ts`

#### 주요 속성
```typescript
@property({ type: Boolean, reflect: true })
expanded = false;  // 전체 트리 펼침/접힘 상태

@property({ type: Array, attribute: false })
data: TableGroupData<T>[] = [];  // 트리 데이터

preserveStructureOnFilter = false;  // 필터 시 구조 유지
indentationInText = false;
```

#### 동작 방식
- `expanded = true`: 모든 레벨의 모든 그룹 펼침
- `expanded = false`: 모든 레벨의 모든 그룹 접힘
- **중간 상태 없음** - All or Nothing

#### 렌더링 구조 (line 738-746)
```typescript
return html`
  <div class="parent">
    ${processingBar()}
    ${when(!this.headersHidden, () => html`<bim-table-row is-header ...>`)}
    <div style="overflow-x: hidden; grid-area: Body">
      <bim-table-children ...></bim-table-children>
    </div>
  </div>
`;
```

### 2. TableChildren (`bim-table-children`)
**파일**: `engine_ui-components/packages/core/src/components/Table/src/TableChildren.ts`

#### 데이터 구조
```typescript
private _data: TableGroupData<T>[] = [];

get data() {
  return this.group?.data.children ?? this._data;
}
```

#### 렌더링 (line 53-68)
```typescript
protected render() {
  this.clean()  // 기존 그룹 제거
  return html`
    <slot></slot>
    ${this.data.map((group) => {
      const tableGroup = document.createElement("bim-table-group");
      this._groups.push(tableGroup);
      tableGroup.table = this.table;
      tableGroup.data = group;
      return tableGroup;  // Light DOM에 렌더링!
    })}
  `;
}
```

**중요**: 그룹들은 **Light DOM**에 렌더링됨 (Shadow DOM 아님)

### 3. TableGroup (`bim-table-group`)
**파일**: `engine_ui-components/packages/core/src/components/Table/src/TableGroup.ts`

#### 주요 속성
```typescript
@property({ type: Boolean, attribute: "children-hidden", reflect: true })
childrenHidden = true;  // 자식 숨김 상태

table: Table<T> | null = null;
data: TableGroupData<T> = { data: {} };
```

#### connectedCallback - 핵심 로직 (line 88-95)
```typescript
connectedCallback() {
  super.connectedCallback();
  if (this.table && this.table.expanded) {
    this.childrenHidden = false;  // 부모가 expanded면 펼침
  } else {
    this.childrenHidden = true;   // 아니면 접힘
  }
}
```

**문제의 핵심**: 
- 부모 테이블의 `expanded` 상태만 확인
- 개별 그룹의 상태를 독립적으로 제어할 수 없음

#### toggleChildren 메서드 (line 102-107)
```typescript
toggleChildren(force?: boolean) {
  this.childrenHidden =
    typeof force === "undefined" ? !this.childrenHidden : !force;

  this.animateTableChildren(true);
}
```

사용법:
- `toggleChildren()`: 토글
- `toggleChildren(true)`: 펼치기
- `toggleChildren(false)`: 접기

#### 렌더링 로직 (line 360-372)
```typescript
let childrenTemplate: TemplateResult | undefined
if (!this._isChildrenEmpty && !this.childrenHidden) {
  const onChildrenCreated = (e?: Element) => {
    if (!e) return
    const children = e as TableChildren<T>
    children.table = this.table;
    children.group = this;
  }

  childrenTemplate = html`
    <bim-table-children ${ref(onChildrenCreated)}>
      ${verticalBranchTemplate}
    </bim-table-children>
  `
}
```

**중요**: `childrenHidden = true`면 `bim-table-children`가 DOM에 추가되지 않음!

## 데이터 구조

### TableGroupData
```typescript
interface TableGroupData<T> {
  data: T;           // 행 데이터
  children?: TableGroupData<T>[];  // 자식 그룹들
}
```

### IFC Spatial Tree 예시
```javascript
[
  {
    data: { Name: "Model-ID", modelId: "..." },
    children: [
      {
        data: { Name: "IFCPROJECT", ... },
        children: [
          {
            data: { Name: "IFCSITE", ... },
            children: [
              {
                data: { Name: "IFCBUILDING", ... },
                children: [
                  {
                    data: { Name: "IFCBUILDINGSTOREY", ... },
                    children: [
                      { data: { Name: "Nivel 1", localId: 123 }, children: [...] },
                      { data: { Name: "Nivel 2", localId: 456 }, children: [...] }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  }
]
```

## DOM 탐색 방법

### 그룹 찾기
```typescript
// Light DOM에서 직접 찾기
const groups = container.querySelectorAll(':scope > bim-table-group');

// 모든 그룹 재귀적으로 찾기 (Shadow DOM 포함)
function findAllGroups(root: Element | ShadowRoot): HTMLElement[] {
  const groups: HTMLElement[] = [];
  groups.push(...Array.from(root.querySelectorAll('bim-table-group')));
  
  for (const el of Array.from(root.querySelectorAll('*'))) {
    const shadow = (el as any).shadowRoot;
    if (shadow) groups.push(...findAllGroups(shadow));
  }
  return groups;
}
```

### 그룹 데이터 접근
```typescript
const group = document.querySelector('bim-table-group') as any;

// 방법 1: data.data (중첩)
const name1 = group.data?.data?.Name;

// 방법 2: data 직접 (경우에 따라 다름)
const name2 = group.data?.Name;

// 안전한 접근
const actualData = group.data?.data || group.data;
const name = actualData?.Name || actualData?.name || '';
```

### Shadow DOM 탐색
```typescript
const group = document.querySelector('bim-table-group');
const shadowRoot = group.shadowRoot;

if (shadowRoot) {
  const row = shadowRoot.querySelector('bim-table-row');
  const children = shadowRoot.querySelector('bim-table-children');
}
```

## 렌더링 타이밍

### 문제점
```typescript
// 1. 데이터 설정
table.data = newData;

// 2. 이 시점에는 아직 그룹이 렌더링되지 않음!
const groups = table.querySelectorAll('bim-table-group'); // 0개

// 3. updateComplete 대기
await table.updateComplete;
// 여전히 expanded = false면 그룹이 없음!

// 4. expanded = true로 설정해야 렌더링됨
table.expanded = true;
await table.updateComplete;
await delay(200);  // 추가 대기 필요

// 5. 이제 그룹들이 존재
const groups = table.querySelectorAll('bim-table-group'); // N개
```

### 올바른 순서
```typescript
// 1. 데이터가 있는지 확인
while (!table.data || table.data.length === 0) {
  await delay(100);
}

// 2. expanded = true 설정
table.expanded = true;
await table.updateComplete;
await delay(200);  // 렌더링 완료 대기

// 3. Shadow Root에서 tableChildren 찾기
const shadowRoot = table.shadowRoot;
const tableChildren = shadowRoot.querySelector('bim-table-children');

// 4. tableChildren의 업데이트 대기
await tableChildren.updateComplete;

// 5. 그룹 찾기
const groups = tableChildren.querySelectorAll('bim-table-group');
```

## 제약사항과 한계

### 1. 전역 expanded 속성
- `table.expanded`는 전체 트리에 영향
- 개별 그룹의 펼침 상태를 독립적으로 제어 불가
- 부분 확장 불가능

### 2. connectedCallback의 강제성
```typescript
connectedCallback() {
  // 무조건 부모의 expanded 상태를 따름
  this.childrenHidden = !this.table?.expanded;
}
```
→ 그룹이 DOM에 추가될 때마다 부모 상태로 리셋됨

### 3. 조건부 렌더링
- `childrenHidden = true`면 자식 DOM 자체가 생성되지 않음
- 따라서 하위 레벨 탐색 불가능

### 4. 성능 문제
- IFC 데이터는 수십 단계의 깊은 계층 구조
- `expanded = true`는 모든 레벨 렌더링
- 수천~수만 개의 DOM 요소 생성
- 초기 렌더링에 수 초 소요 가능

## 표준 사용 예제

### spatialTree (표준 구현)
**파일**: `engine_ui-components/packages/obc/src/components/tables/SpatialTree/src/template.ts`

```typescript
export const spatialTreeTemplate = (state: SpatialTreeState) => {
  return BUI.html`
    <bim-table 
      @rowcreated=${onRowCreated} 
      @cellcreated=${onCellCreated} 
      ${BUI.ref(onTableCreated)} 
      headers-hidden>
      <bim-label slot="missing-data" ...>
        No models available!
      </bim-label>
    </bim-table>
  `;
};
```

**특징**:
- `expanded` 속성을 설정하지 않음 (기본값 `false`)
- 사용자가 caret를 클릭하여 수동으로 펼침
- 자동 확장 기능 없음

### itemsData (Properties)
**파일**: `engine_ui-components/packages/obc/src/components/tables/ItemsData/src/template.ts`

```typescript
export const itemsDataTemplate = (state: ItemsDataState) => {
  return BUI.html`
    <bim-table 
      @rowcreated=${onRowCreated} 
      @cellcreated=${onCellCreated} 
      ${BUI.ref(onTableCreated)} 
      headers-hidden>
      ...
    </bim-table>
  `;
};
```

**특징**:
- 동일하게 자동 확장 없음
- 표준 구현에서는 수동 조작만 지원

## 가능한 해결 방안

### 방안 1: 라이브러리 포크 및 수정
```typescript
// TableGroup.ts 수정
connectedCallback() {
  super.connectedCallback();
  // expanded 체크하지 않고, 항상 데이터가 있으면 렌더링
  if (this.data.children && this.data.children.length > 0) {
    this.childrenHidden = false; // 또는 depth 기반 로직
  }
}
```

**장점**: 완전한 제어 가능  
**단점**: 라이브러리 유지보수 부담

### 방안 2: 커스텀 확장 속성 추가
```typescript
// Table 컴포넌트에 새 속성 추가
@property({ type: Number })
maxExpandDepth?: number;

// TableGroup에서 depth 계산 후 적용
connectedCallback() {
  const depth = this.calculateDepth();
  if (this.table?.maxExpandDepth !== undefined) {
    this.childrenHidden = depth >= this.table.maxExpandDepth;
  } else {
    this.childrenHidden = !this.table?.expanded;
  }
}
```

### 방안 3: Virtual Scrolling 도입
- 보이는 영역의 노드만 렌더링
- `expanded = true` 사용하되 성능 최적화
- 복잡한 구현 필요

### 방안 4: 현재 방식 수용
```typescript
// expanded = true로 전체 렌더링 후 선택적 접기
table.expanded = true;
await delay(300);

// 불필요한 그룹들 접기
const allGroups = findAllGroups(table);
for (const group of allGroups) {
  if (shouldCollapse(group)) {
    group.toggleChildren(false);
  }
}
```

**장점**: 안정적, 표준 API 사용  
**단점**: 초기 렌더링 성능 문제

## 유용한 헬퍼 함수

### 대기 함수
```typescript
async function waitForElementUpdate(element: any) {
  try {
    const updateComplete = element?.updateComplete;
    if (updateComplete instanceof Promise) await updateComplete;
  } catch (error) {
    // Silently ignore
  }
  await delay(0);
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

### 테이블 찾기
```typescript
function findTableElement(element: any): HTMLElement | null {
  if (element?.tagName?.toLowerCase() === "bim-table") {
    return element as HTMLElement;
  }
  
  // querySelector로 찾기
  if (element?.querySelector) {
    const nested = element.querySelector("bim-table");
    if (nested) return nested;
  }
  
  // Shadow DOM에서 찾기
  if (element?.shadowRoot) {
    const shadowTable = element.shadowRoot.querySelector("bim-table");
    if (shadowTable) return shadowTable;
  }
  
  return null;
}
```

### 그룹 깊이 계산
```typescript
function getGroupDepth(group: HTMLElement): number {
  let depth = 0;
  let current: HTMLElement | null = group;
  
  while (current) {
    if (current.tagName?.toLowerCase() === 'bim-table-children') {
      depth++;
    }
    
    // Shadow DOM 경계 넘기
    const host = (current.getRootNode() as ShadowRoot)?.host;
    current = host ? host.parentElement : current.parentElement;
  }
  
  return depth;
}
```

## 디버깅 팁

### 1. 데이터 확인
```typescript
console.log('table.data:', table.data);
console.log('table.expanded:', table.expanded);
console.log('tableChildren.data:', tableChildren.data);
```

### 2. DOM 확인
```typescript
console.log('tableChildren.children.length:', tableChildren.children.length);
const allGroups = tableChildren.querySelectorAll('bim-table-group');
console.log('All groups found:', allGroups.length);
```

### 3. 개별 그룹 상태
```typescript
for (const group of groups) {
  const g = group as any;
  const data = g.data?.data || g.data;
  console.log('Group:', data?.Name, 'childrenHidden:', g.childrenHidden);
}
```

### 4. Shadow DOM 구조
```typescript
const group = groups[0];
console.log('Has shadowRoot:', !!group.shadowRoot);
if (group.shadowRoot) {
  const children = group.shadowRoot.querySelector('bim-table-children');
  console.log('Has children container:', !!children);
}
```

## 결론

`@thatopen/ui`의 `bim-table`은 간단하고 안정적이지만, **선택적 레벨 확장을 설계상 지원하지 않습니다**.

현재 프로젝트에서는:
1. **표준 방식 사용** (수동 펼치기/접기)
2. **전체 펼친 후 접기** (성능 감수)
3. **라이브러리 포크** (장기적 해결)

중 하나를 선택해야 합니다.

IFC 데이터의 복잡성을 고려하면, **가장 안정적인 방법은 표준 방식**을 유지하고 사용자가 필요한 부분만 수동으로 펼치도록 하는 것입니다.

