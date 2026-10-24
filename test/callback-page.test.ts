import { describe, expect, test } from "bun:test";
import { renderErrorHtml, renderSuccessHtml } from "../src/callback-page";

describe("OAuth callback pages", () => {
  test("inline the Maraha fonts so the page renders after the loopback server closes", () => {
    const html = renderSuccessHtml();
    expect(html).toContain(
      'font-family: "IM Fell English"; font-style: normal',
    );
    expect(html).toContain(
      'font-family: "IM Fell English"; font-style: italic',
    );
    expect(html).toContain('font-family: "Alegreya Sans"');
    expect(html).toContain("url(data:font/woff2;base64,");
    expect(html).not.toMatch(/url\((?!data:)/);
  });

  test("use Maraha tokens without red, rounded corners or shadows", () => {
    for (const html of [renderSuccessHtml(), renderErrorHtml()]) {
      expect(html).toContain("--vault: #141026");
      expect(html).not.toMatch(/border-radius|box-shadow|#ef4444|#10b981/);
    }
  });

  test("success page announces the sign-in as a status", () => {
    const html = renderSuccessHtml();
    expect(html).toContain('role="status"');
    expect(html).toContain("Signed in");
    // A tab opened by shell.openExternal can't close itself, so the page
    // asks the user to close it and runs no script.
    expect(html).toContain("Close this tab and return to the Lampas Launcher.");
    expect(html).not.toContain("<script");
  });

  test("error page shows the message as an escaped alert", () => {
    const html = renderErrorHtml('Portal said <script>alert("x")</script>');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Sign-in failed");
    expect(html).toContain(
      "Portal said &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
    expect(html).not.toContain('<script>alert("x")</script>');
  });

  test("error page without a message says what to do next", () => {
    const html = renderErrorHtml();
    expect(html).toContain(
      "Sign-in didn&#39;t work. Go back to the launcher and try again.",
    );
  });
});
