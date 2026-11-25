using System.Text.RegularExpressions;

namespace Sandstone.BrowserTests.Infrastructure;

// Page and FrameLocator expose matching operations without a shared .NET
// interface. Dispatch to those document scopes rather than an html locator:
// scoping accessibility queries to html can miss modal/top-layer content.
internal sealed class BrowserSurface(IPage page, IFrameLocator? frame)
{
    public ILocator Locator(string selector) => frame?.Locator(selector) ?? page.Locator(selector);
    public IFrameLocator FrameLocator(string selector) => frame?.FrameLocator(selector) ?? page.FrameLocator(selector);
    public ILocator GetByRole(AriaRole role, LocatorGetByRoleOptions? options = null) => frame != null
        ? frame.GetByRole(role, new() { Name = options?.Name, NameRegex = options?.NameRegex, Exact = options?.Exact,
            Checked = options?.Checked, Disabled = options?.Disabled, Expanded = options?.Expanded, IncludeHidden = options?.IncludeHidden, Level = options?.Level, Pressed = options?.Pressed, Selected = options?.Selected })
        : page.GetByRole(role, new() { Name = options?.Name, NameRegex = options?.NameRegex, Exact = options?.Exact,
            Checked = options?.Checked, Disabled = options?.Disabled, Expanded = options?.Expanded, IncludeHidden = options?.IncludeHidden, Level = options?.Level, Pressed = options?.Pressed, Selected = options?.Selected });
    public ILocator GetByText(string text, LocatorGetByTextOptions? options = null) => frame != null
        ? frame.GetByText(text, new() { Exact = options?.Exact }) : page.GetByText(text, new() { Exact = options?.Exact });
    public ILocator GetByText(Regex text, LocatorGetByTextOptions? options = null) => frame != null
        ? frame.GetByText(text, new() { Exact = options?.Exact }) : page.GetByText(text, new() { Exact = options?.Exact });
    public ILocator GetByLabel(string text, LocatorGetByLabelOptions? options = null) => frame != null
        ? frame.GetByLabel(text, new() { Exact = options?.Exact }) : page.GetByLabel(text, new() { Exact = options?.Exact });
    public ILocator GetByPlaceholder(string text, LocatorGetByPlaceholderOptions? options = null) => frame != null
        ? frame.GetByPlaceholder(text, new() { Exact = options?.Exact }) : page.GetByPlaceholder(text, new() { Exact = options?.Exact });
    public ILocator GetByTitle(string text, LocatorGetByTitleOptions? options = null) => frame != null
        ? frame.GetByTitle(text, new() { Exact = options?.Exact }) : page.GetByTitle(text, new() { Exact = options?.Exact });
}
