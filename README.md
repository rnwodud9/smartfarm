# 스마트팜 모니터링 대시보드

https://smurffarm.netlify.app · ESP32가 쓰는 원본과 센서별 평균을 읽는 정적 사이트. 시간은 한국 시간으로 표시한다.

| 화면 | Supabase 데이터 |
|---|---|
| 센서 카드 | 최근 3분 내 각 센서의 마지막 측정값 |
| 실시간 | `sensor_data`의 최근 30분 원본 |
| 최근 7일 | `sensor_history`의 5분 평균 |
| 최근 2개월 | 같은 표의 시간 평균, 최근 60일 |
| 전체 기간 | 같은 표의 일별 평균, 한국 자정 기준 |

`sensor_data`는 보드별로 일부 필드만 보내도 된다. `초음파`에는 센서에서 수면까지 거리(cm)를 보내고 측정 실패는 NULL로 보낸다. 높이 50cm, 용량 200L, 단면이 일정한 물통에서 남은 물량은 `(50 − 거리) × 4` L다. 센서 설치 기준은 만수면이며 만수면에 더 가까워질 때 기기의 최소 측정거리도 고려한다. 2cm 미만이나 52cm 초과는 제외하고 빈 통 근처의 50~52cm는 0L로 표시한다. 10L 이하면 물 부족으로 표시한다. 초음파가 없는 예전 기록은 빈 값이다.

pH는 0~14, 습도는 0~100%로 고정한다. EC(µS/cm)는 0~3,000, 기온은 0~40°C에서 시작해 해당 기간의 관측값이 벗어나면 확장한다. 2026년 11월 12일 17:10 KST 이전 EC는 화면에서 mS/cm를 µS/cm로 환산한다. 그 시각을 포함하는 시간·일 집계는 개별 측정값을 환산한 뒤 계산한 평균을 표시한다. DB 원본에는 수신 당시 숫자가 남는다. 상추의 pH 및 EC 범위는 [오클라호마주립대 수경재배 자료](https://extension.okstate.edu/fact-sheets/electrical-conductivity-and-ph-guide-for-hydroponics), 상대습도와 주야 기온 목표는 [코넬대 수경상추 핸드북](https://cea.cals.cornell.edu/files/2019/06/Cornell-CEA-Lettuce-Handbook-.pdf)을 사용한다.

## 운영

- `public.sensor_data`는 원본, `public.sensor_history`는 5분·시간·일별 평균이다. 두 표에 RLS가 적용된다. 대시보드는 공개 읽기 키만 사용한다.
- 5분마다 평균을 갱신하고, 매일 한국시간 03시에 원본 30일·5분 평균 14일·시간 평균 60일 기준으로 정리한다. 일별 평균은 계속 보관한다.
- `supabase/migrations/20261118_sensor_history.sql`은 기존 운영 DB에 적용한 일회성 이전이다. 이전 3개 표는 `smartfarm_internal`에 보관하고, 옛 공개 주소는 호환용 읽기 뷰로 제공한다. 다른 서비스는 이전 범위에 포함하지 않는다.
- 로컬 확인은 `python3 -m http.server 8000`. GitHub `rnwodud9/smartfarm`의 `main`에 반영하면 Netlify가 자동 배포한다.
