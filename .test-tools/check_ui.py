from playwright.sync_api import sync_playwright, expect
from pathlib import Path

with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path="C:/Program Files/Google/Chrome/Application/chrome.exe",
        headless=True,
    )
    page = browser.new_page(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto("http://127.0.0.1:8089")
    explain_grandma = page.get_by_role("button", name="Explain: Grandma's after the game.", exact=True)
    expect(explain_grandma).to_be_visible()
    explain_grandma.click()
    expect(page.get_by_text("A little context", exact=True)).to_be_visible()
    expect(page.get_by_text("is the group's nickname for Swayam's house.", exact=False)).to_be_visible()
    page.screenshot(path=".test-tools/explanation.png", full_page=True)
    page.get_by_role("textbox", name="Follow-up question", exact=True).fill("Whose house?")
    page.get_by_role("button", name="Ask follow-up", exact=True).click()
    expect(page.get_by_text("is the group's nickname for Swayam's house.", exact=False)).to_be_visible()
    page.get_by_role("button", name="Jump to message:", exact=False).first.click()
    expect(page.get_by_text("Viewing the original conversation")).to_be_visible()
    page.get_by_role("button", name="Back to latest", exact=True).click()
    page.get_by_role("button", name="Explain: Bring the moon waffle.", exact=True).click()
    expect(page.get_by_text("I couldn't find a reliable explanation", exact=False)).to_be_visible()
    page.get_by_role("button", name="Ask Swayam", exact=True).click()
    expect(page.get_by_text("Sent privately to Swayam", exact=True)).to_be_visible()
    page.get_by_role("button", name="Close", exact=True).click()
    page.get_by_role("button", name="Swayam", exact=True).click()
    page.get_by_role("button", name="Private explanations", exact=False).click()
    expect(page.get_by_text("Priya asked you", exact=True)).to_be_visible()
    page.get_by_role("textbox", name="Reply to Priya", exact=True).fill("The moon waffle is our waffle-shaped frisbee.")
    page.get_by_role("button", name="Send private answer", exact=True).click()
    expect(page.get_by_text("Swayam replied", exact=True)).to_be_visible()
    page.get_by_role("button", name="Close", exact=True).click()
    page.get_by_role("button", name="Alex", exact=True).click()
    page.get_by_role("button", name="Private explanations", exact=False).click()
    expect(page.get_by_text("Your private requests will appear here.")).to_be_visible()
    page.get_by_role("button", name="Close", exact=True).click()
    page.get_by_role("button", name="Priya", exact=True).click()
    page.get_by_role("button", name="Explain: Bring the moon waffle.", exact=True).click()
    expect(page.get_by_text("The moon waffle is our waffle-shaped frisbee.", exact=True).first).to_be_visible()
    page.screenshot(path=".test-tools/private-answer.png", full_page=True)
    assert not errors, errors
    print("PASS: explain, follow-up, source jump, private ask, reply, and third-user isolation.")
    browser.close()
