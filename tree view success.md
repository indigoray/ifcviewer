# Tree View 선택적 확장 성공!

## 문제 해결

### 핵심 발견
**`TableChildren` (`bim-table-children`)도 Shadow DOM을 가지고 있습니다!**

소스 코드(`engine_ui-components`)에는 Shadow DOM이 없었지만, 실제 빌드된 `@thatopen/ui` 라이브러리에서는 `TableChildren`도 Shadow DOM을 사용합니다.

### 올바른 DOM 탐색 방법

```typescript
// ❌ 잘못된 방법 - Light DOM에서 찾기
const table = document.querySelector('bim-table');
const tableChildren = table.shadowRoot.querySelector('bim-table-children');
const groups = tableChildren.querySelectorAll('bim-table-group'); // 0개 반환!

// ✅ 올바른 방법 - tableChildren의 shadowRoot에서 찾기
const table = document.querySelector('bim-table');
const tableChildren = table.shadowRoot.querySelector('bim-table-children');
const tableChildrenShadow = tableChildren.shadowRoot;  // 🔑 핵심!
const groups = tableChildrenShadow.querySelectorAll('bim-table-group'); // 그룹 찾아짐!
```

### 재귀 탐색 시 주의사항

```typescript
// 그룹의 자식 찾기
const group = groups[0];
const groupShadow = group.shadowRoot;
const childrenContainer = groupShadow.querySelector('bim-table-children');

// ❌ 잘못된 방법
const childGroups = childrenContainer.querySelectorAll('bim-table-group'); // 0개

// ✅ 올바른 방법
const childrenShadow = childrenContainer.shadowRoot;  // 🔑 핵심!
const childGroups = childrenShadow.querySelectorAll('bim-table-group'); // 찾아짐!
```

## 성공한 구현

### Properties - 특정 깊이까지 확장

```typescript
async function expandPropertiesToLevel(tableElement: HTMLElement, maxDepth: number) {
  const table = findTableElement(tableElement);
  const tableComponent = table as any;
  
  // 데이터 대기
  while (!tableComponent.data || tableComponent.data.length === 0) {
    await delay(100);
  }
  
  const shadowRoot = table.shadowRoot;
  const tableChildren = shadowRoot.querySelector('bim-table-children');
  
  // 🔑 tableChildren의 shadowRoot에서 그룹 찾기!
  const tableChildrenShadow = tableChildren.shadowRoot;
  const rootGroups = tableChildrenShadow.querySelectorAll('bim-table-group');
  
  // 재귀적으로 maxDepth까지만 확장
  const expandToDepth = async (containerShadow: ShadowRoot, currentDepth: number) => {
    if (currentDepth >= maxDepth) return;
    
    const groups = containerShadow.querySelectorAll('bim-table-group');
    
    for (const group of groups) {
      // toggleChildren로 펼치기 (UI caret 클릭과 동일)
      group.toggleChildren(true);
      await waitForElementUpdate(group);
      
      // 자식 탐색
      const groupShadow = group.shadowRoot;
      const childrenContainer = groupShadow?.querySelector('bim-table-children');
      
      if (childrenContainer) {
        // 🔑 자식 tableChildren의 shadowRoot도 체크!
        const childrenShadow = childrenContainer.shadowRoot;
        if (childrenShadow) {
          await expandToDepth(childrenShadow, currentDepth + 1);
        }
      }
    }
  };
  
  await expandToDepth(tableChildrenShadow, 0);
}
```

### Spatial Tree - Building Storey까지 확장

```typescript
async function expandToStoreyLevel(tableElement: HTMLElement) {
  const table = findTableElement(tableElement);
  const tableComponent = table as any;
  
  // 데이터 대기
  while (!tableComponent.data || tableComponent.data.length === 0) {
    await delay(100);
  }
  
  const shadowRoot = table.shadowRoot;
  const tableChildren = shadowRoot.querySelector('bim-table-children');
  
  // 🔑 tableChildren의 shadowRoot에서 그룹 찾기!
  const tableChildrenShadow = tableChildren.shadowRoot;
  
  // 재귀적으로 IFCBUILDINGSTOREY 찾기
  const expandUntilStorey = async (containerShadow: ShadowRoot): Promise<boolean> => {
    const groups = containerShadow.querySelectorAll('bim-table-group');
    
    for (const group of groups) {
      const name = group.data?.data?.Name || group.data?.Name || '';
      
      // IFCBUILDINGSTOREY 찾으면 펼치고 종료
      if (name === 'IFCBUILDINGSTOREY') {
        group.toggleChildren(true);
        return true;
      }
      
      // 모든 그룹을 펼쳐서 탐색
      group.toggleChildren(true);
      await waitForElementUpdate(group);
      
      // 자식에서 계속 탐색
      const groupShadow = group.shadowRoot;
      const childrenContainer = groupShadow?.querySelector('bim-table-children');
      
      if (childrenContainer) {
        // 🔑 자식 tableChildren의 shadowRoot도 체크!
        const childrenShadow = childrenContainer.shadowRoot;
        if (childrenShadow) {
          const found = await expandUntilStorey(childrenShadow);
          if (found) return true;
        }
      }
    }
    
    return false;
  };
  
  await expandUntilStorey(tableChildrenShadow);
}
```

## 결과

### Spatial Tree
- 01 → IFCPROJECT → 0001 → IFCSITE → Default → IFCBUILDING → (빈이름) → **IFCBUILDINGSTOREY**
- Storey instances (Nivel 1, Nivel 2)만 보임
- 각 storey의 자식들은 접혀 있음
- ✅ **필요한 경로만 렌더링하므로 성능 문제 없음!**

### Properties
- 93개의 선택된 요소
- 각 요소의 첫 번째 레벨 속성만 펼쳐짐 (Category, LocalId, Name, Tag 등)
- 중첩된 속성 (ContainedInStructure, IsDefinedBy)은 접혀 있음
- ✅ **필요한 레벨만 렌더링하므로 성능 문제 없음!**

## 핵심 교훈

1. **소스 코드와 빌드 결과가 다를 수 있다**
   - `engine_ui-components`는 참고용 소스
   - 실제 `node_modules/@thatopen/ui`는 다르게 빌드됨

2. **브라우저 디버깅의 중요성**
   - JavaScript evaluate로 직접 확인
   - Shadow DOM 구조를 실제로 탐색
   - 가정하지 말고 확인하기

3. **Shadow DOM 중첩**
   - 모든 `bim-table-children`이 Shadow DOM을 가짐
   - 재귀 탐색 시 매번 `shadowRoot` 체크 필수

4. **UI 동작 모방**
   - `toggleChildren()`은 UI caret 클릭과 동일
   - `table.expanded`는 전역 상태, `toggleChildren`은 개별 제어
   - 필요한 경로만 `toggleChildren`으로 펼치면 성능 문제 없음

## 파일 위치
- 구현: `/home/indigoray/my_projects/IfcViewer/src/main.ts`
  - `expandPropertiesToLevel()` (line ~1182-1276)
  - `expandToStoreyLevel()` (line ~1282-1394)

