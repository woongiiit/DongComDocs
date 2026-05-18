# DongComDocs

동국대학교 컴퓨터공학과 사무용 문서 제출·프로세스 관리 웹앱 초기 구현입니다.

## 구조

- `apps/web` — Vite + React (프론트)
- `apps/api` — Express + Prisma + PostgreSQL (백엔드 API)

## 로컬 실행

### 1) PostgreSQL

`DATABASE_URL`에 맞는 DB를 준비합니다. (로컬 Docker 예시)

```powershell
docker run --name dongcomdocs-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=dongcomdocs -p 5432:5432 -d postgres:16
```

### 2) API 환경 변수

`apps/api/.env` 파일을 만듭니다. (`apps/api/.env.example` 참고)

```
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/dongcomdocs?schema=public"
JWT_SECRET="로컬-개발용-32자-이상-임의문자열"
PORT=4000
ADMIN_ID=2020123456
```

`ADMIN_ID`는 쉼표로 구분할 수 있으며, 여기에 적힌 학번은 로그인 시 관리자 역할로 동기화됩니다.

### 3) 의존성 및 DB 스키마

PowerShell에서는 명령을 한 줄씩 실행합니다.

```powershell
cd C:\Users\meta\DongComDocs
npm install
cd apps\api
npx prisma db push
cd ..\..
```

User 테이블 구조가 바뀐 뒤 기존 행과 충돌하면 개발 DB에서만 다음으로 초기화할 수 있습니다. (**데이터가 모두 삭제됩니다.**)

```powershell
cd C:\Users\meta\DongComDocs\apps\api
npx prisma db push --force-reset
```

### 4) 개발 서버

터미널 두 개에서:

```powershell
cd C:\Users\meta\DongComDocs
npm run dev:api
```

```powershell
cd C:\Users\meta\DongComDocs
npm run dev:web
```

브라우저에서 `http://localhost:5173` — API는 Vite 프록시로 `http://localhost:4000` 에 연결됩니다.

## 동작 요약

- 학번·비밀번호로 로그인합니다. 첫 로그인 시 해당 학번 계정이 생성되며, 비밀번호는 bcrypt로 저장됩니다.
- `ADMIN_ID`에 등록된 학번은 관리자 역할로 처리됩니다.
- 관리자: 프로세스 등록, 파일 규칙·LLM 프롬프트(스텁) 설정.
- 학생: 프로세스 선택 후 파일 업로드 → 서버에서 규칙 검증 → 규칙 실행 스텁 호출.

## Railway 배포 메모

- DB: 프로젝트에 **PostgreSQL** 추가 → API 서비스 **Variables**에 `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (Reference 변수). 없으면 배포 시 `P1012 Environment variable not found: DATABASE_URL` 로 크래시.
- 서비스 3개: **Postgres** + **API** + **Web** (같은 GitHub repo, Root Directory만 다름).
- **API** (`DongComDocs_Backend` 등): Root Directory = `apps/api` — `DATABASE_URL` 등 API 변수 필요.
- **Web** (`DoncComDocs_Front` 등): Root Directory = `apps/web` — **DATABASE_URL 불필요**. 루트(`.`)로 두면 API `start:prod`가 실행되어 `DATABASE_URL is not set` 로 크래시함.
- Web 빌드 시 Docker ARG: `VITE_API_URL=https://<api-공개-URL>`
- 각 서비스 **Settings → Config-as-code 파일 경로** (저장소 루트 기준 절대 경로):
  - API: `/apps/api/railway.json`
  - Web: `/apps/web/railway.json`
- **Settings → Build → Builder** 가 `Dockerfile` 인지 확인 (Railpack이면 Web 빌드가 실패할 수 있음).
- API에 `JWT_SECRET`, `ADMIN_ID`, 프론트 도메인에 맞춘 `CORS_ORIGIN` 설정.
- 웹 빌드 산출물은 정적 호스팅 또는 `vite preview`/Node 정적 서버로 서빙.

업로드 파일은 기본적으로 `apps/api/uploads` 로컬 폴더에 저장됩니다. 프로덕션에서는 볼륨 또는 객체 스토리지 연동을 권장합니다.
