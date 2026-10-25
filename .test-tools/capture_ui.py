from playwright.sync_api import sync_playwright, expect

with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path="C:/Program Files/Google/Chrome/Application/chrome.exe",
        headless=True,
    )
    page = browser.new_page(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    requests = []
    page.on("request", lambda request: requests.append(request.url))
    page.goto("http://127.0.0.1:8089")
    bubble = page.get_by_label("Swayam: Grandma's after the game.. Hold to explain.", exact=True)
    expect(bubble).to_be_visible()
    assert not any("/explain/" in url for url in requests)
    bubble.click(delay=700)
    expect(page.get_by_text("A little context", exact=True)).to_be_visible()
    expect(page.get_by_text("is the group's nickname for Swayam's house.", exact=False)).to_be_visible()
    page.wait_for_timeout(800)
    page.screenshot(path=".test-tools/explanation.png", full_page=True)
    page.get_by_role("button", name="Close", exact=True).click()
    page.wait_for_timeout(400)
    page.get_by_role("button", name="Explain: Bring the moon waffle.", exact=True).click()
    expect(page.get_by_text("The moon waffle is our waffle-shaped frisbee.", exact=True).first).to_be_visible()
    page.wait_for_timeout(800)
    page.screenshot(path=".test-tools/private-answer.png", full_page=True)
    print("PASS: no unsolicited explanation; long-press opens sheet; saved private answer appears.")
    browser.close()
