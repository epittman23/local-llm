import { useSyncExternalStore } from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

// The shadcn template reads `next-themes`, which needs its own
// ThemeProvider and has no idea about this app's theme mechanism (a `dark`/
// `light` class on <html>, set by Base.astro's anti-FOUC script from
// localStorage.theme). Read that class directly instead, so a toast always
// matches what the page is actually showing, including an explicit choice
// that disagrees with the OS setting.
const subscribeToThemeClass = (notify: () => void) => {
  const observer = new MutationObserver(notify)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
  return () => observer.disconnect()
}
const readTheme = () => (document.documentElement.classList.contains("dark") ? "dark" : "light")

const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useSyncExternalStore(subscribeToThemeClass, readTheme, () => "light")

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
