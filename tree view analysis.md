# @thatopen/ui bim-table 선택적 확장 구현 가이드

## 핵심 발견: TableChildren의 Shadow DOM

**소스 코드(`engine_ui-components`)와 실제 빌드된 라이브러리(`@thatopen/ui`)가 다릅니다!**

`bim-table-children` 컴포넌트도 Shadow DOM을 가지고 있으며, 그룹들은 이 Shadow DOM 안에 렌더링됩니다.

## 컴포넌트 계층 구조 (실제 빌드 버전)

```
bim-table (Table)
└─ shadowRoot
   └─ bim-table-children (TableChildren)
      └─ shadowRoot  ⚠️ CRITICAL: 소스코드에는 없지만 빌드버전에는 있음!
         ├─ bim-table-group (TableGroup)
         │  └─ shadowRoot
         │     ├─ bim-table-row (TableRow)
         │     └─ bim-table-children (자식이 있을 경우)
         │        └─ shadowRoot  ⚠️ 자식도 shadowRoot 가짐!
         │           ├─ bim-table-group
         │           │  └─ shadowRoot
         │           │     └─ ...
         │           └─ bim-table-group
         ├─ bim-table-group
         └─ bim-table-group
```

## 선택적 확장 구현

### 성공 사례 1: Properties - 특정 깊이까지 확장

**목표**: 요소 선택 시 속성을 1레벨까지만 자동으로 펼치기

```typescript
async function expandPropertiesToLevel(tableElement: HTMLElement, maxDepth: number) {
  const table = tableElement.tagName?.toLowerCase() === 'bim-table' 
    ? tableElement 
    : findTableElement(tableElement);
  
  if (!table) return;

  const tableComponent = table as any;
  
  // 1. 데이터가 로드될 때까지 대기
  let attempts = 0;
  while ((!tableComponent.data || tableComponent.data.length === 0) && attempts < 50) {
    await delay(100);
    attempts++;
  }
  
  if (!tableComponent.data || tableComponent.data.length === 0) {
    return;
  }
  
  // 2. Shadow DOM 탐색
  const shadowRoot = table.shadowRoot;
  if (!shadowRoot) return;

  const tableChildren = shadowRoot.querySelector('bim-table-children');
  if (!tableChildren) return;

  // 🔑 핵심: tableChildren도 shadowRoot를 가짐!
  const tableChildrenShadow = (tableChildren as any).shadowRoot;
  if (!tableChildrenShadow) return;

  // 3. 루트 그룹들 찾기
  const rootGroups = Array.from(tableChildrenShadow.querySelectorAll('bim-table-group'));
  if (rootGroups.length === 0) return;

  // 4. 재귀적으로 maxDepth까지만 확장
  const expandToDepth = async (containerShadow: ShadowRoot, currentDepth: number): Promise<void> => {
    if (currentDepth >= maxDepth) return;
    
    const groups = Array.from(containerShadow.querySelectorAll('bim-table-group')) as HTMLElement[];
    
    for (const group of groups) {
      const groupElement = group as any;
      
      // toggleChildren로 펼치기 (UI caret 클릭과 동일)
      if (typeof groupElement.toggleChildren === 'function') {
        groupElement.toggleChildren(true);
        await waitForElementUpdate(groupElement);
        await delay(100);
      }
      
      // 자식 탐색
      const groupShadow = groupElement.shadowRoot;
      if (groupShadow) {
        const childrenContainer = groupShadow.querySelector('bim-table-children');
        if (childrenContainer) {
          // 🔑 자식 tableChildren의 shadowRoot도 체크!
          const childrenShadow = (childrenContainer as any).shadowRoot;
          if (childrenShadow) {
            await expandToDepth(childrenShadow, currentDepth + 1);
          }
        }
      }
    }
  };
  
  await expandToDepth(tableChildrenShadow, 0);
}
```

### 성공 사례 2: Spatial Tree - Building Storey까지 확장

**목표**: "Expand to Storey" 버튼 클릭 시 IFCBUILDINGSTOREY 레벨까지만 펼치기

```typescript
async function expandToStoreyLevel(tableElement: HTMLElement) {
  const table = tableElement.tagName?.toLowerCase() === 'bim-table' 
    ? tableElement 
    : findTableElement(tableElement);
  
  if (!table) return;

  const tableComponent = table as any;
  
  // 1. 데이터가 로드될 때까지 대기
  let attempts = 0;
  while ((!tableComponent.data || tableComponent.data.length === 0) && attempts < 50) {
    await delay(100);
    attempts++;
  }
  
  if (!tableComponent.data || tableComponent.data.length === 0) {
    return;
  }
  
  // 2. Shadow DOM 탐색
  const shadowRoot = table.shadowRoot;
  if (!shadowRoot) return;

  const tableChildren = shadowRoot.querySelector('bim-table-children');
  if (!tableChildren) return;

  // 🔑 핵심: tableChildren의 shadowRoot에서 그룹 찾기!
  const tableChildrenShadow = (tableChildren as any).shadowRoot;
  if (!tableChildrenShadow) return;

  // 3. 재귀적으로 IFCBUILDINGSTOREY 찾기
  const expandUntilStorey = async (containerShadow: ShadowRoot): Promise<boolean> => {
    const groups = Array.from(containerShadow.querySelectorAll('bim-table-group')) as HTMLElement[];
    
    for (const group of groups) {
      const groupElement = group as any;
      const actualData = groupElement.data?.data || groupElement.data;
      const name = actualData?.Name || actualData?.name || '';
      
      // IFCBUILDINGSTOREY 찾으면 펼치고 종료
      if (name === 'IFCBUILDINGSTOREY') {
        if (typeof groupElement.toggleChildren === 'function') {
          groupElement.toggleChildren(true);
          await waitForElementUpdate(groupElement);
        }
        return true;
      }
      
      // 모든 그룹을 펼쳐서 탐색 (모델 이름, IFC 타입 등)
      if (typeof groupElement.toggleChildren === 'function') {
        groupElement.toggleChildren(true);
        await waitForElementUpdate(groupElement);
        await delay(100);
      }
      
      // 자식에서 계속 탐색
      const groupShadow = groupElement.shadowRoot;
      if (groupShadow) {
        const childrenContainer = groupShadow.querySelector('bim-table-children');
        if (childrenContainer) {
          // 🔑 자식 tableChildren의 shadowRoot도 체크!
          const childrenShadow = (childrenContainer as any).shadowRoot;
          if (childrenShadow) {
            const found = await expandUntilStorey(childrenShadow);
            if (found) return true;
          }
        }
      }
    }
    
    return false;
  };
  
  await expandUntilStorey(tableChildrenShadow);
}
```

## DOM 탐색 방법

### ❌ 잘못된 방법 (Light DOM에서 찾기)
```typescript
const table = document.querySelector('bim-table');
const tableChildren = table.shadowRoot.querySelector('bim-table-children');
const groups = tableChildren.querySelectorAll('bim-table-group'); 
// ❌ 0개 반환! (Light DOM에는 없음)
```

### ✅ 올바른 방법 (Shadow DOM에서 찾기)
```typescript
const table = document.querySelector('bim-table');
const tableChildren = table.shadowRoot.querySelector('bim-table-children');

// 🔑 tableChildren의 shadowRoot에서 찾기!
const tableChildrenShadow = tableChildren.shadowRoot;
const groups = tableChildrenShadow.querySelectorAll('bim-table-group');
// ✅ 그룹 찾아짐!
```

### 재귀 탐색 시 주의사항
```typescript
// 자식 bim-table-children 탐색
const childrenContainer = groupShadow.querySelector('bim-table-children');

// ❌ Light DOM에서 찾기
const childGroups = childrenContainer.querySelectorAll('bim-table-group'); // 0개

// ✅ Shadow DOM에서 찾기
const childrenShadow = childrenContainer.shadowRoot;  // 🔑 핵심!
const childGroups = childrenShadow.querySelectorAll('bim-table-group'); // 찾아짐!
```

## 브라우저 디버깅 방법

### JavaScript Console에서 확인
```javascript
// 테이블 찾기
const table = document.querySelector('bim-table');
console.log('Table expanded:', table.expanded);
console.log('Table data:', table.data);

// tableChildren 확인
const tableChildren = table.shadowRoot.querySelector('bim-table-children');
console.log('Has shadowRoot:', !!tableChildren.shadowRoot);

// 그룹 찾기
const shadow = tableChildren.shadowRoot;
const groups = shadow.querySelectorAll('bim-table-group');
console.log('Groups found:', groups.length);

// 재귀 탐색
function findAllGroups(root) {
  const groups = [];
  groups.push(...Array.from(root.querySelectorAll('bim-table-group')));
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot) groups.push(...findAllGroups(el.shadowRoot));
  }
  return groups;
}

const allGroups = findAllGroups(shadow);
console.log('Total groups:', allGroups.length);
allGroups.slice(0, 5).forEach(g => {
  console.log('Group:', g.data?.data?.Name || g.data?.Name);
});
```

## 주요 컴포넌트 속성

### Table (`bim-table`)
```typescript
@property({ type: Boolean, reflect: true })
expanded = false;  // 전체 트리 펼침/접힘

@property({ type: Array })
data: TableGroupData<T>[] = [];  // 트리 데이터

preserveStructureOnFilter = false;
```

### TableGroup (`bim-table-group`)
```typescript
@property({ type: Boolean, attribute: "children-hidden" })
childrenHidden = true;  // 자식 숨김 상태

toggleChildren(force?: boolean) {
  this.childrenHidden = typeof force === "undefined" ? !this.childrenHidden : !force;
}
```

**사용법**:
- `group.toggleChildren()`: 토글
- `group.toggleChildren(true)`: 펼치기 (UI caret 클릭과 동일)
- `group.toggleChildren(false)`: 접기

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
    data: { Name: "01", modelId: "01" },
    children: [
      {
        data: { Name: "IFCPROJECT", ... },
        children: [
          {
            data: { Name: "0001", localId: 123 },
            children: [
              {
                data: { Name: "IFCSITE", ... },
                children: [
                  {
                    data: { Name: "Default", localId: 456 },
                    children: [
                      {
                        data: { Name: "IFCBUILDING", ... },
                        children: [
                          {
                            data: { Name: "IFCBUILDINGSTOREY", ... },
                            children: [
                              { data: { Name: "Nivel 1", localId: 789 }, children: [...] },
                              { data: { Name: "Nivel 2", localId: 790 }, children: [...] }
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
      }
    ]
  }
]
```

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
  
  if (element?.querySelector) {
    const nested = element.querySelector("bim-table");
    if (nested) return nested;
  }
  
  if (element?.shadowRoot) {
    const shadowTable = element.shadowRoot.querySelector("bim-table");
    if (shadowTable) return shadowTable;
  }
  
  return null;
}
```

### 그룹 데이터 안전하게 접근
```typescript
const group = document.querySelector('bim-table-group') as any;

// 안전한 접근 (중첩된 data 구조 고려)
const actualData = group.data?.data || group.data;
const name = actualData?.Name || actualData?.name || '';
```

## 성능 최적화

### ✅ 성공: 필요한 경로만 렌더링
- `table.expanded`를 건드리지 않음 (기본값 `false` 유지)
- 필요한 그룹만 `toggleChildren(true)` 호출
- 각 레벨마다 딱 필요한 노드만 확장
- **수십 단계 IFC 데이터도 빠르게 처리**

### ❌ 실패: 전체 렌더링 후 접기
```typescript
// 이 방식은 사용하지 말 것!
table.expanded = true;  // 모든 레벨 렌더링 (수천 개 DOM 노드)
await delay(300);
// 이후 불필요한 노드 접기
```

**문제점**:
- IFC 데이터는 수십 단계의 깊은 계층
- 전체 렌더링에 수 초 소요
- 사용자가 UI가 멈춘 것처럼 느낌

## 실제 동작 결과

### Spatial Tree
```
확장 경로:
01 (모델)
└─ IFCPROJECT
   └─ 0001 (프로젝트 인스턴스)
      └─ IFCSITE
         └─ Default (사이트 인스턴스)
            └─ IFCBUILDING
               └─ (빈 이름)
                  └─ IFCBUILDINGSTOREY ← 여기서 멈춤!
                     ├─ Nivel 1 (접혀 있음)
                     └─ Nivel 2 (접혀 있음)
```

**결과**: 
- Nivel 1, Nivel 2만 보임
- 각 층의 자식들(벽, 창문 등)은 렌더링되지 않음
- ✅ 성능 문제 없음!

### Properties (93개 요소 선택 시)
```
요소 1: Muro básico:Partición con capa de yeso:163541
├─ Category: IFCWALLSTANDARDCASE  ← 레벨 1 (펼쳐짐)
├─ LocalId: 186                   ← 레벨 1 (펼쳐짐)
├─ Name: ...                      ← 레벨 1 (펼쳐짐)
├─ ContainedInStructure           ← 레벨 1 (접혀 있음)
│  └─ [...] (렌더링 안 됨)
└─ IsDefinedBy                    ← 레벨 1 (접혀 있음)
   └─ [...] (렌더링 안 됨)

요소 2: Muro básico:Partición con capa de yeso:163542
├─ Category: IFCWALLSTANDARDCASE
├─ LocalId: 294
...
```

**결과**:
- 각 요소의 직접 속성만 펼쳐짐
- 중첩된 속성들은 렌더링되지 않음
- ✅ 성능 문제 없음!

## 핵심 교훈

### 1. 소스 코드 vs 빌드 결과
- `engine_ui-components`: 참고용 소스 (TypeScript)
- `node_modules/@thatopen/ui`: 실제 빌드 결과 (번들링됨)
- **Shadow DOM 구조가 다를 수 있음!**

### 2. 브라우저 디버깅의 중요성
```javascript
// Console에서 직접 확인
const tableChildren = document.querySelector('bim-table')
  .shadowRoot.querySelector('bim-table-children');
  
console.log('Has shadowRoot:', !!tableChildren.shadowRoot);  // true!
```

→ 코드로 추측하지 말고, 브라우저에서 직접 확인하기

### 3. Shadow DOM 중첩 패턴
- 모든 `bim-table-children`이 Shadow DOM을 가짐
- 재귀 탐색 시 매번 체크 필수:
  ```typescript
  const childrenShadow = childrenContainer.shadowRoot;
  if (childrenShadow) {
    // childrenShadow에서 그룹 찾기
  }
  ```

### 4. UI 동작 모방
- `toggleChildren(true)`: UI에서 caret 클릭과 동일
- 필요한 경로만 하나씩 `toggleChildren` 호출
- `table.expanded`는 건드리지 않음

## 표준 사용 예제 참고

### spatialTree
**파일**: `engine_ui-components/packages/obc/src/components/tables/SpatialTree/example.ts`

표준 구현에서는 자동 확장 기능이 없고, 사용자가 수동으로 caret을 클릭하여 펼칩니다.

## 구현 위치

- **파일**: `/home/indigoray/my_projects/IfcViewer/src/main.ts`
- **Properties**: `expandPropertiesToLevel()` (line ~1182-1276)
- **Spatial Tree**: `expandToStoreyLevel()` (line ~1282-1394)

## 성공 요인

1. ✅ `tableChildren.shadowRoot` 사용
2. ✅ 재귀 탐색 시 모든 `tableChildren`의 `shadowRoot` 체크
3. ✅ `toggleChildren(true)`로 개별 제어
4. ✅ `table.expanded` 건드리지 않음
5. ✅ 브라우저 디버깅으로 실제 구조 확인
