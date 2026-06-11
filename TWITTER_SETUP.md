# Enabling Twitter/X Downloads

Twitter/X requires login cookies to download videos (they removed anonymous access). Here's how to enable it on your deployment.

## Step 1: Export your X cookies

1. Log into [x.com](https://x.com) in Chrome or Firefox
2. Install a cookie export extension:
   - Chrome: **"Get cookies.txt LOCALLY"**
   - Firefox: **"cookies.txt"**
3. While on x.com, click the extension and **export/copy** the cookies in **Netscape format**

You'll get text that looks like:
```
# Netscape HTTP Cookie File
.x.com    TRUE    /    TRUE    1234567890    auth_token    abc123...
.x.com    TRUE    /    TRUE    1234567890    ct0    def456...
```

## Step 2: Add cookies to Railway

1. Open your Railway project → click the **saveit** service
2. Go to the **Variables** tab
3. Add a new variable:
   - Name: `TWITTER_COOKIES`
   - Value: paste the entire cookie text (all lines)
4. Railway auto-redeploys

That's it. Twitter downloads now work.

## When it stops working

Twitter cookies expire (typically every few weeks, or when you log out of X). When Twitter downloads start failing again:
- Re-export cookies (Step 1)
- Update the `TWITTER_COOKIES` variable in Railway (Step 2)

## Security note

These cookies grant access to your X account session. The app only uses them server-side to authenticate yt-dlp requests — they're never exposed to users or committed to git. Still, use a throwaway/secondary X account if you're concerned, and rotate them if you suspect exposure.
