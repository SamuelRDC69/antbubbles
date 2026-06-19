This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deployment Notes

Production uses two services:

1. Web app: Next.js server on your existing web deployment
2. Worker: always-on Railway service running `worker/index.ts`

Required shared env vars:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

The worker now serves:

- `GET /healthz`

The worker is responsible for:

- polling Alcor snapshots into Redis
- polling Taco/Nefty token snapshots into Redis
- building Taco/Nefty chart series from the SQLite candle store and publishing them into Redis

The web app reads Taco/Nefty modal chart data from shared Redis in production, which avoids depending on local disk or a public worker chart endpoint.
