# Tree View Expansion Optimization 실패 사례 정리

## 목표
`@thatopen/ui`의 `bim-table` 컴포넌트에서 특정 레벨까지만 선택적으로 트리를 펼치는 기능 구현
- **Properties 탭**: 요소 선택 시 1레벨까지만 자동 펼침
- **Spatial Tree 탭**: "Expand to Storey" 버튼 클릭 시 Building Storey 레벨까지만 펼침

## 문제점
IFC 데이터는 수십 단계의 깊은 계층 구조를 가지고 있어, `table.expanded = true`로 전체를 펼치면 성능 문제 발생.

## 시도 1: `expanded` 속성 건드리지 않고 개별 그룹 펼치기
### 접근 방법
```typescript
// table.expanded = false 상태 유지
// 개별 그룹에 toggleChildren(true) 호출
const groups = tableChildren.querySelectorAll('bim-table-group');
for (const group of groups) {
  group.toggleChildren(true);
}
```

### 실패 원인
- `table.expanded = false` 상태에서는 첫 번째 레벨의 그룹조차 DOM에 렌더링되지 않음
- `querySelectorAll`로 그룹을 찾을 수 없음 (0개 반환)

### 관련 코드
`TableGroup.connectedCallback()` (line 88-95):
```typescript
connectedCallback() {
  if (this.table && this.table.expanded) {
    this.childrenHidden = false;
  } else {
    this.childrenHidden = true;  // expanded = false면 무조건 접힘
  }
}
```

## 시도 2: Delay 추가하여 렌더링 대기
### 접근 방법
```typescript
await delay(200); // 그룹이 렌더링될 시간 기다리기
const groups = tableChildren.querySelectorAll('bim-table-group');
```

### 실패 원인
- 시간을 얼마나 기다려도 `expanded = false` 상태에서는 그룹이 렌더링되지 않음
- delay를 500ms, 1000ms로 늘려도 동일한 결과

## 시도 3: `updateComplete` Promise 대기
### 접근 방법
```typescript
await waitForElementUpdate(table);
await waitForElementUpdate(tableChildren);
const groups = tableChildren.querySelectorAll('bim-table-group');
```

### 실패 원인
- LitElement의 `updateComplete`는 컴포넌트의 렌더링 완료만 보장
- 하지만 `expanded = false` 상태에서는 자식 그룹들이 렌더링 대상이 아니므로 여전히 DOM에 없음

## 시도 4: 데이터 로드 대기
### 접근 방법
```typescript
// table.data가 존재할 때까지 기다리기
while ((!tableComponent.data || tableComponent.data.length === 0) && attempts < 50) {
  await delay(100);
  attempts++;
}
```

### 결과
- 부분 성공: `table.data`에는 데이터가 존재함
- 하지만 여전히 그룹이 DOM에 렌더링되지 않음
- `tableChildren.data`에도 데이터는 있지만, `tableChildren.children.length = 0`

## 시도 5: `requestUpdate()` 강제 호출
### 접근 방법
```typescript
tableChildrenComponent.requestUpdate();
await waitForElementUpdate(tableChildren);
```

### 실패 원인
- `requestUpdate()`는 재렌더링을 트리거하지만, `expanded = false` 상태에서는 여전히 그룹을 렌더링하지 않음

## 시도 6: 임시로 `expanded = true` 후 다시 `false`
### 접근 방법
```typescript
tableComponent.expanded = true;
await delay(200);
// 그룹 찾기 시도
tableComponent.expanded = false;
```

### 결과
- UI에서 잠깐 펼쳐졌다가 다시 접히는 것 확인 (사용자가 목격)
- 하지만 `expanded = false`로 되돌린 후에는 그룹이 DOM에서 사라짐
- `querySelectorAll`로 여전히 0개 반환

## 시도 7: `expanded = true` 유지 후 선택적 접기
### 접근 방법
```typescript
// expanded = true 상태 유지
tableComponent.expanded = true;
await delay(300);

// 모든 그룹이 렌더링된 후
const allGroups = findAllGroups(tableChildren);

// 필요없는 깊이의 그룹들을 수동으로 접기
for (const group of allGroups) {
  const depth = getGroupDepth(group);
  if (depth > maxDepth) {
    group.toggleChildren(false);
  }
}
```

### 문제점
- **성공적으로 작동하지만, 치명적인 성능 문제 발생**
- IFC 데이터는 수십 단계의 깊은 계층 구조
- `expanded = true`는 모든 레벨의 모든 요소를 렌더링
- 수천~수만 개의 DOM 요소가 생성됨
- 렌더링에 수 초가 걸리고, 이후에 접는 작업에도 시간 소요
- 사용자 경험 저하

## 시도 8: Light DOM vs Shadow DOM 혼동
### 문제
- 처음에는 그룹들이 Shadow DOM에 있다고 생각함
- 실제로는 `TableChildren`이 그룹들을 **Light DOM**에 렌더링
- Shadow DOM과 Light DOM을 혼동하여 잘못된 selector 사용

### 해결
- `:scope >` selector 사용
- Shadow DOM 체크 제거
- 하지만 근본적인 문제(렌더링 안 됨)는 해결되지 않음

## 근본 원인 분석

### `@thatopen/ui` 컴포넌트 구조
1. **Table 컴포넌트** (`bim-table`)
   - `expanded` 속성이 전체 트리의 펼침/접힘 상태 제어
   - `expanded = true`: 모든 레벨 렌더링
   - `expanded = false`: 최상위 레벨도 접힌 상태

2. **TableGroup 컴포넌트** (`bim-table-group`)
   - `connectedCallback()`에서 부모 테이블의 `expanded` 상태 확인
   - 부모가 `expanded = false`면 무조건 `childrenHidden = true`
   - `childrenHidden = true`면 자식 DOM을 아예 렌더링하지 않음

3. **TableChildren 컴포넌트** (`bim-table-children`)
   - `render()` 메서드에서 `this.data.map()`으로 그룹 생성
   - 하지만 각 그룹의 `childrenHidden` 상태에 따라 자식 렌더링 결정

### 왜 선택적 확장이 불가능한가?
```typescript
// TableGroup.ts render() - line 360-372
let childrenTemplate: TemplateResult | undefined
if (!this._isChildrenEmpty && !this.childrenHidden) {
  // childrenHidden = true이면 이 코드가 실행되지 않음
  childrenTemplate = html`
    <bim-table-children ...></bim-table-children>
  `
}
```

→ `childrenHidden = true`면 자식 `bim-table-children` 자체가 DOM에 추가되지 않음  
→ 따라서 그 아래 레벨을 찾을 수 없음  
→ 선택적으로 특정 레벨만 펼치는 것이 원천적으로 불가능

## 결론

**`@thatopen/ui`의 `bim-table` 컴포넌트는 선택적 레벨 확장을 지원하지 않습니다.**

### 현재 가능한 옵션
1. **전체 펼치기/접기만 사용** (`table.expanded = true/false`)
   - 장점: 표준 API, 안정적
   - 단점: 깊은 IFC 데이터에서 성능 문제

2. **전체 펼친 후 불필요한 부분 접기** (시도 7)
   - 장점: 원하는 결과 달성 가능
   - 단점: 초기 렌더링 성능 문제 심각

3. **컴포넌트 수정/포크**
   - `TableGroup.connectedCallback()` 수정
   - `expanded` 속성과 무관하게 그룹 렌더링 가능하도록
   - 단점: 라이브러리 유지보수 부담

### 권장 사항
현재로서는 표준 `table.expanded` 속성만 사용하고, 사용자가 수동으로 트리를 펼치도록 하는 것이 가장 안정적입니다.

만약 자동 확장이 필수라면, `@thatopen/ui` 라이브러리를 포크하여 `TableGroup` 컴포넌트를 수정해야 합니다.

## 시도한 코드 위치
- `/home/indigoray/my_projects/IfcViewer/src/main.ts`
  - `expandPropertiesToLevel()` (line 1182-1285)
  - `expandToStoreyLevel()` (line 1291-1395)

## 참고 소스
- `engine_ui-components/packages/core/src/components/Table/src/TableGroup.ts`
- `engine_ui-components/packages/core/src/components/Table/src/TableChildren.ts`
- `engine_ui-components/packages/core/src/components/Table/index.ts`

