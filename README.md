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

## Advertising review

Advertisers choose an hourly start, pay, then enter review. Blockchain-verified submissions appear at `/admin/ads`; owner approval schedules the bubble for its booked slot. Configure Upstash as described in `proxy.ts` and set a strong `AD_ADMIN_TOKEN`.

Bundle USD prices are floors. Each published booking adds pressure to an uncapped, constant-product-style curve backed by seven days of virtual capacity. Pressure has a seven-day half-life, so sustained demand raises prices while inactivity returns them toward the floor. KEK and DEAL amounts use the live Alcor USD price when checkout is prepared.

Generate the token yourself and keep it out of git:

```bash
openssl rand -hex 32
```

Set the output as `AD_ADMIN_TOKEN` in the production environment and enter the same value on `/admin/ads`.

## GIF picker

To enable the advert GIF picker, create a GIPHY API key and set `NEXT_PUBLIC_GIPHY_API_KEY`. GIPHY's search API is designed for browser-side use, so this key is intentionally public to the client. Without it, advertisers can still paste a GIF, image, or IPFS URL directly.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
