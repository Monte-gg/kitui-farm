# Keep WebView JavaScript interfaces and AndroidX components intact
-keepattributes *Annotation*
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
