# IFC Viewer 예시

That Open Components 공식 문서를 참고해 구성한 기본 IFC 뷰어입니다. `@thatopen/components`가 제공하는 `Worlds`, `FragmentsManager`, `IfcLoader` 컴포넌트를 연결해 간단한 장면을 만들고, 샘플 IFC 또는 로컬 파일을 변환해 화면에 표시합니다.

## 빠른 시작

```bash
npm install
npm run dev
```

브라우저에서 출력되는 로컬 주소(기본값 `http://localhost:5173`)로 접속하면 뷰어가 열립니다. 오른쪽 패널에서 샘플 IFC를 불러오거나, 로컬 `.ifc` 파일을 선택해 변환을 진행할 수 있습니다.

## 구현 노트

- `@thatopen/components`의 권장 패턴을 따라 `Components` 컨테이너를 만들고, `Worlds`로 장면/카메라/렌더러를 구성했습니다.
- IFC 로딩 과정은 공식 예제와 동일하게 `FragmentsManager`를 초기화한 뒤 `IfcLoader`의 `load` 메서드로 처리하며, 진행률은 `processData.progressCallback`을 통해 표시합니다.
- 프래그먼트 워커는 문서에서 안내한 경로(`https://thatopen.github.io/engine_fragment/resources/worker.mjs`)에서 가져와 Object URL로 생성합니다.
- 성능 모니터링을 위해 `stats.js`를 추가했고, 카메라 휴식 이벤트마다 프래그먼트를 갱신해 장면 상태가 최신으로 유지되도록 했습니다.

## 참고 문서

- [Getting started](https://docs.thatopen.com/components/getting-started)
- [Creating components](https://docs.thatopen.com/components/creating-components)
- [Clean components guide](https://docs.thatopen.com/components/clean-components-guide)
