# Shadow DOM 활용 비교: 표준 vs 우리 구현

## 표준 구현 (spatialTree, itemsData)

### 접근 방식
**Shadow DOM을 직접 조작하지 않음**

```typescript
// spatialTree 표준 구현
const [spatialTree] = CUI.tables.spatialTree({
  components,
  models: []
});

spatialTree.preserveStructureOnFilter = true;
// 끝! Shadow DOM 건드리지 않음
```

### 동작 방식
- `bim-table` 컴포넌트를 생성만 함
- 모든 렌더링은 컴포넌트 내부에서 자동 처리
- **사용자가 UI에서 caret을 클릭**하여 수동으로 펼침/접기
- `table.expanded` 속성만 사용 (전체 펼치기/접기)

### 코드 위치
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
- Shadow DOM 탐색 없음
- 이벤트 핸들러만 등록 (`@rowcreated`, `@cellcreated`)
- 컴포넌트의 public API만 사용

---

## 우리 구현 (선택적 확장)

### 접근 방식
**Shadow DOM을 직접 탐색하고 조작**

```typescript
// 우리의 구현
const [spatialTree, updateSpatialTree] = CUI.tables.spatialTree({
  components,
  models: []
});

// Shadow DOM을 깊이 탐색하여 선택적 확장
await expandToStoreyLevel(spatialTree);
```

### 동작 방식
1. **테이블의 Shadow DOM 탐색**
   ```typescript
   const shadowRoot = table.shadowRoot;
   const tableChildren = shadowRoot.querySelector('bim-table-children');
   ```

2. **TableChildren의 Shadow DOM 탐색** (핵심 발견!)
   ```typescript
   const tableChildrenShadow = tableChildren.shadowRoot;
   const groups = tableChildrenShadow.querySelectorAll('bim-table-group');
   ```

3. **재귀적으로 Shadow DOM 탐색하며 선택적 확장**
   ```typescript
   const expandUntilStorey = async (containerShadow: ShadowRoot) => {
     const groups = containerShadow.querySelectorAll('bim-table-group');
     
     for (const group of groups) {
       // 조건에 맞으면 toggleChildren(true) 호출
       if (shouldExpand(group)) {
         group.toggleChildren(true);
         
         // 자식의 Shadow DOM도 탐색
         const childrenContainer = group.shadowRoot.querySelector('bim-table-children');
         const childrenShadow = childrenContainer?.shadowRoot;
         if (childrenShadow) {
           await expandUntilStorey(childrenShadow);
         }
       }
     }
   };
   ```

### Shadow DOM 탐색 경로

```
사용자 코드
  ↓
table.shadowRoot (테이블의 Shadow DOM)
  ↓
querySelector('bim-table-children')
  ↓
tableChildren.shadowRoot (TableChildren의 Shadow DOM) ⚠️ 핵심!
  ↓
querySelectorAll('bim-table-group')
  ↓
group.shadowRoot (각 그룹의 Shadow DOM)
  ↓
querySelector('bim-table-children') (자식 컨테이너)
  ↓
childrenContainer.shadowRoot (자식 TableChildren의 Shadow DOM) ⚠️
  ↓
재귀...
```

## Shadow DOM 활용 비교표

| 항목 | 표준 구현 | 우리 구현 |
|------|----------|----------|
| Shadow DOM 탐색 | ❌ 없음 | ✅ 재귀적 탐색 |
| DOM 구조 이해 필요 | ❌ 불필요 | ✅ 필수 |
| 자동 확장 | ❌ 없음 | ✅ 가능 |
| 구현 복잡도 | 단순 | 복잡 |
| 유지보수 | 쉬움 | 어려움 |
| 성능 제어 | 제한적 | 세밀함 |
| 브라우저 디버깅 | 불필요 | 필수 |

## 왜 Shadow DOM 탐색이 필요했는가?

### 문제
```typescript
// 표준 방식: 전역 제어만 가능
table.expanded = true;  // 모든 레벨 펼침 (수천 개 노드)
table.expanded = false; // 모든 레벨 접힘
```

→ IFC 데이터는 수십 단계 깊이  
→ `expanded = true`는 성능 문제 발생

### 해결
```typescript
// 우리 방식: 개별 그룹 제어
// 필요한 경로만 하나씩 toggleChildren(true)
group1.toggleChildren(true);  // 01 펼침
  group2.toggleChildren(true);  // IFCPROJECT 펼침
    group3.toggleChildren(true);  // 0001 펼침
      ...
        groupN.toggleChildren(true);  // IFCBUILDINGSTOREY 펼침
```

→ 필요한 노드만 렌더링  
→ 성능 문제 해결

## Shadow DOM 탐색의 핵심 코드

### 잘못된 시도 (실패)
```typescript
// ❌ Light DOM에서 찾기
const tableChildren = shadowRoot.querySelector('bim-table-children');
const groups = tableChildren.querySelectorAll('bim-table-group');
// → 0개 반환!
```

### 성공한 구현
```typescript
// ✅ Shadow DOM 체크
const tableChildren = shadowRoot.querySelector('bim-table-children');

// 🔑 핵심: tableChildren도 shadowRoot를 가짐!
const tableChildrenShadow = tableChildren.shadowRoot;

// 여기서 그룹 찾기!
const groups = tableChildrenShadow.querySelectorAll('bim-table-group');
// → 그룹 찾아짐!
```

### 재귀 탐색 패턴
```typescript
async function traverseShadowDOM(containerShadow: ShadowRoot) {
  // 현재 레벨의 그룹들
  const groups = containerShadow.querySelectorAll('bim-table-group');
  
  for (const group of groups) {
    // 그룹 처리
    group.toggleChildren(true);
    
    // 그룹의 Shadow DOM 탐색
    const groupShadow = group.shadowRoot;
    if (groupShadow) {
      const childrenContainer = groupShadow.querySelector('bim-table-children');
      
      if (childrenContainer) {
        // 🔑 자식 tableChildren의 shadowRoot도 체크!
        const childrenShadow = childrenContainer.shadowRoot;
        
        if (childrenShadow) {
          // 재귀
          await traverseShadowDOM(childrenShadow);
        }
      }
    }
  }
}
```

## 브라우저에서 직접 확인한 구조

### JavaScript Console 테스트
```javascript
// 1. 테이블 찾기
const table = document.querySelector('bim-table');

// 2. 테이블의 Shadow DOM
const tableShadow = table.shadowRoot;
console.log('Table has shadowRoot:', !!tableShadow); // true

// 3. TableChildren 찾기
const tableChildren = tableShadow.querySelector('bim-table-children');
console.log('TableChildren found:', !!tableChildren); // true

// 4. TableChildren의 Shadow DOM (핵심 발견!)
const tableChildrenShadow = tableChildren.shadowRoot;
console.log('TableChildren has shadowRoot:', !!tableChildrenShadow); 
// true! ← 소스 코드에는 없었음!

// 5. 그룹 찾기
const groups = tableChildrenShadow.querySelectorAll('bim-table-group');
console.log('Groups found:', groups.length); // 1개 이상

// 6. Light DOM에서 찾기 시도
const groupsInLight = tableChildren.querySelectorAll('bim-table-group');
console.log('Groups in light DOM:', groupsInLight.length); // 0개!
```

## 왜 소스 코드와 다른가?

### 소스 코드 (TableChildren.ts)
```typescript
export class TableChildren<T extends TableRowData> extends LitElement {
  // Shadow DOM 설정 없음
  
  protected render() {
    return html`
      <slot></slot>
      ${this.data.map((group) => {
        const tableGroup = document.createElement("bim-table-group");
        return tableGroup;  // Light DOM에 렌더링처럼 보임
      })}
    `;
  }
}
```

### 빌드 결과 (@thatopen/ui)
- LitElement가 자동으로 Shadow DOM 생성
- `render()`의 결과물이 Shadow DOM 안에 렌더링
- 번들링 과정에서 추가 최적화 가능

**결론**: TypeScript 소스만 보고는 알 수 없음. 브라우저로 확인 필수!

## 표준 구현이 Shadow DOM을 쓰지 않는 이유

### 장점
1. **단순함**: 컴포넌트 API만 사용
2. **안정성**: 내부 구조 변경에 영향 없음
3. **유지보수**: 라이브러리 업데이트 시 호환성 유지

### 단점
1. **제한된 제어**: 전역 `expanded`만 사용 가능
2. **성능 최적화 어려움**: All or Nothing
3. **커스터마이징 불가**: 선택적 확장 불가능

## 우리 구현이 Shadow DOM을 쓰는 이유

### 목표
- 자동으로 특정 레벨까지만 확장
- 깊은 IFC 데이터에서 성능 유지

### 방법
- Shadow DOM을 직접 탐색
- 개별 그룹을 `toggleChildren`로 제어
- 필요한 경로만 렌더링

### 트레이드오프
**장점**:
- ✅ 선택적 확장 가능
- ✅ 성능 최적화
- ✅ 사용자 경험 향상

**단점**:
- ❌ 내부 구조 의존
- ❌ 라이브러리 변경 시 깨질 수 있음
- ❌ 복잡한 구현
- ❌ 브라우저 디버깅 필수

## Expand All은 Shadow DOM 순회가 필요 없는 이유

### 질문
"Expand All" 버튼 클릭 시 Shadow DOM을 직접 순회하지 않았는데, 왜 모든 레벨이 펼쳐질까?

### 답변: 컴포넌트 내부의 자동 전파

```typescript
// Expand All 구현
async function expandAllInSpatialTree(tableElement: HTMLElement) {
  const table = findTableElement(tableElement);
  if (!table) return;
  
  // 단 한 줄!
  table.expanded = true;
  
  // 이것만으로 모든 레벨이 펼쳐짐!
}
```

**내부 동작 순서**:

1. **`table.expanded = true` 설정**

2. **Table 컴포넌트가 재렌더링**
   - `bim-table-children` 생성/업데이트

3. **TableChildren이 그룹들 렌더링**
   ```typescript
   // TableChildren.render()
   ${this.data.map((group) => {
     const tableGroup = document.createElement("bim-table-group");
     tableGroup.table = this.table;  // 부모 table 참조 전달!
     tableGroup.data = group;
     return tableGroup;
   })}
   ```

4. **각 TableGroup의 `connectedCallback()` 호출**
   ```typescript
   // TableGroup.connectedCallback()
   connectedCallback() {
     if (this.table && this.table.expanded) {  // ← table.expanded 확인!
       this.childrenHidden = false;  // ✅ 펼침!
     } else {
       this.childrenHidden = true;
     }
   }
   ```

5. **`childrenHidden = false`이므로 자식 `bim-table-children` 렌더링**

6. **3-5번 과정이 재귀적으로 반복**
   - 모든 레벨의 모든 그룹이 자동으로 펼쳐짐
   - Shadow DOM 순회 필요 없음!

### 핵심: table.expanded의 전파 메커니즘

```
table.expanded = true 설정
  ↓
TableChildren 렌더링
  ↓
TableGroup 생성 (tableGroup.table = this.table 전달)
  ↓
TableGroup.connectedCallback()
  ↓
this.table.expanded 확인 → true!
  ↓
this.childrenHidden = false
  ↓
자식 TableChildren 렌더링
  ↓
자식 TableGroup 생성 (같은 table 참조 전달)
  ↓
재귀적으로 반복...
```

**모든 그룹이 같은 `table` 참조를 가지므로, `table.expanded` 변경이 전체 트리에 즉시 영향을 줍니다!**

## 선택적 확장은 왜 Shadow DOM 순회가 필요한가?

### 문제
```typescript
// table.expanded = true → 모든 레벨 자동 펼침 (원하지 않음)
// table.expanded = false → 모든 레벨 자동 접힘 (원하지 않음)
```

→ **중간 상태가 없음!**

### 해결: 직접 Shadow DOM 탐색

```typescript
// 1. table.expanded = false 유지 (자동 전파 방지)

// 2. Shadow DOM을 수동으로 탐색
const tableChildrenShadow = tableChildren.shadowRoot;
const groups = tableChildrenShadow.querySelectorAll('bim-table-group');

// 3. 필요한 그룹만 개별적으로 펼치기
for (const group of groups) {
  if (shouldExpand(group)) {
    group.toggleChildren(true);  // connectedCallback 우회!
  }
}
```

**`toggleChildren(true)` 직접 호출**:
- `connectedCallback`의 자동 설정을 우회
- 개별 그룹의 상태를 독립적으로 제어
- `table.expanded` 상태와 무관하게 동작

### 비교

| 방식 | table.expanded | Shadow DOM 순회 | 결과 |
|------|----------------|-----------------|------|
| Expand All | `true` | ❌ 불필요 | 자동 전파로 모든 레벨 펼침 |
| Collapse All | `false` | ❌ 불필요 | 자동 전파로 모든 레벨 접힘 |
| 선택적 확장 | `false` 유지 | ✅ 필수 | 수동 탐색하며 필요한 것만 펼침 |

## 결론

**표준 구현 (Expand All)**:
- `table.expanded = true` 한 줄
- 컴포넌트가 알아서 재귀적 렌더링
- Shadow DOM 몰라도 됨

**우리 구현 (선택적 확장)**:
- `table.expanded = false` 유지
- Shadow DOM을 직접 탐색
- 필요한 그룹만 `toggleChildren(true)` 호출
- **Shadow DOM 깊이 이해 필수**

브라우저 디버깅으로 Shadow DOM 구조를 발견했기에 가능했습니다!

