package com.kituifarm.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;

public class MainActivity extends AppCompatActivity {

    private static final String START_URL = "https://monte-gg.github.io/kitui-farm/";
    private static final String APP_UA_SUFFIX = " KituiFarmAndroidApp/1.0.1";

    private WebView webView;
    private View loadingView;
    private View errorView;
    private boolean hasPageError = false;
    private boolean initialLoadDone = false;
    private String lastFailedUrl = START_URL;
    private ValueCallback<Uri[]> fileUploadCallback;
    private String pendingGeoOrigin;
    private GeolocationPermissions.Callback pendingGeoCallback;

    private final ActivityResultLauncher<Intent> fileChooserLauncher =
            registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
                if (fileUploadCallback == null) return;
                Uri[] results = null;
                if (result.getResultCode() == RESULT_OK && result.getData() != null) {
                    Intent data = result.getData();
                    if (data.getClipData() != null) {
                        int count = data.getClipData().getItemCount();
                        results = new Uri[count];
                        for (int i = 0; i < count; i++) {
                            results[i] = data.getClipData().getItemAt(i).getUri();
                        }
                    } else if (data.getData() != null) {
                        results = new Uri[]{ data.getData() };
                    }
                }
                fileUploadCallback.onReceiveValue(results);
                fileUploadCallback = null;
            });

    private final ActivityResultLauncher<String[]> locationPermissionLauncher =
            registerForActivityResult(new ActivityResultContracts.RequestMultiplePermissions(), grants -> {
                boolean granted = Boolean.TRUE.equals(grants.get(Manifest.permission.ACCESS_FINE_LOCATION))
                        || Boolean.TRUE.equals(grants.get(Manifest.permission.ACCESS_COARSE_LOCATION));
                if (pendingGeoCallback != null && pendingGeoOrigin != null) {
                    pendingGeoCallback.invoke(pendingGeoOrigin, granted, false);
                }
                pendingGeoCallback = null;
                pendingGeoOrigin = null;
            });

    private class NativeBridge {
        @JavascriptInterface
        public void printPage() {
            runOnUiThread(() -> {
                if (webView == null) return;
                PrintManager printManager = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                if (printManager == null) return;
                PrintDocumentAdapter adapter = webView.createPrintDocumentAdapter("KITUI_FARM_Receipt");
                printManager.print("KITUI FARM Receipt", adapter, new PrintAttributes.Builder().build());
            });
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webView);
        loadingView = findViewById(R.id.loadingView);
        errorView = findViewById(R.id.errorView);
        Button tryAgainButton = findViewById(R.id.tryAgainButton);

        configureWebView();
        configureBackNavigation();

        tryAgainButton.setOnClickListener(v -> retryLoad());

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
            initialLoadDone = true;
            loadingView.setVisibility(View.GONE);
        } else {
            loadStartOrError();
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setGeolocationEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setSupportZoom(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(false);

        String defaultUa = settings.getUserAgentString();
        if (defaultUa != null && !defaultUa.contains("KituiFarmAndroidApp")) {
            settings.setUserAgentString(defaultUa + APP_UA_SUFFIX);
        }

        webView.addJavascriptInterface(new NativeBridge(), "KituiAndroid");

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri == null) return false;
                String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();

                if ("tel".equals(scheme)) {
                    openExternalAction(new Intent(Intent.ACTION_DIAL, uri));
                    return true;
                }
                if ("mailto".equals(scheme)) {
                    openExternalAction(new Intent(Intent.ACTION_SENDTO, uri));
                    return true;
                }
                if ("sms".equals(scheme) || "smsto".equals(scheme)) {
                    openExternalAction(new Intent(Intent.ACTION_SENDTO, uri));
                    return true;
                }
                if ("http".equals(scheme)) {
                    Uri secureUri = uri.buildUpon().scheme("https").build();
                    view.loadUrl(secureUri.toString());
                    return true;
                }
                if ("https".equals(scheme)) {
                    return false;
                }
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                hasPageError = false;
                if (url != null && url.startsWith("https://")) {
                    lastFailedUrl = url;
                }
                if (!initialLoadDone) {
                    loadingView.setVisibility(View.VISIBLE);
                }
                errorView.setVisibility(View.GONE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                CookieManager.getInstance().flush();
                // Wire window.print() to Android's native PrintManager and hide any download-app card
                view.evaluateJavascript(
                        "(function(){try{" +
                        "if(window.KituiAndroid&&window.KituiAndroid.printPage){window.print=function(){window.KituiAndroid.printPage();};}" +
                        "var c=document.getElementById('kfAndroidApkCard');if(c)c.remove();" +
                        "document.documentElement.classList.add('kf-native-android-app');" +
                        "}catch(e){}})();",
                        null
                );
                if (!hasPageError) {
                    initialLoadDone = true;
                    loadingView.setVisibility(View.GONE);
                    errorView.setVisibility(View.GONE);
                    webView.setVisibility(View.VISIBLE);
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request != null && request.isForMainFrame()) {
                    String failingUrl = request.getUrl() != null ? request.getUrl().toString() : START_URL;
                    showInAppError(failingUrl);
                }
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                showInAppError(lastFailedUrl);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                boolean hasFine = ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
                boolean hasCoarse = ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
                if (hasFine || hasCoarse) {
                    callback.invoke(origin, true, false);
                    return;
                }
                pendingGeoOrigin = origin;
                pendingGeoCallback = callback;
                locationPermissionLauncher.launch(new String[]{
                        Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION
                });
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                if (fileUploadCallback != null) {
                    fileUploadCallback.onReceiveValue(null);
                }
                fileUploadCallback = filePathCallback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                String[] acceptTypes = fileChooserParams != null ? fileChooserParams.getAcceptTypes() : null;
                if (acceptTypes != null && acceptTypes.length == 1 && acceptTypes[0] != null && !acceptTypes[0].isEmpty()) {
                    intent.setType(acceptTypes[0]);
                } else {
                    intent.setType("*/*");
                }
                try {
                    fileChooserLauncher.launch(Intent.createChooser(intent, "Choose file"));
                    return true;
                } catch (ActivityNotFoundException e) {
                    fileUploadCallback = null;
                    return false;
                }
            }
        });
    }

    private void configureBackNavigation() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (errorView.getVisibility() == View.VISIBLE && webView.canGoBack()) {
                    errorView.setVisibility(View.GONE);
                    webView.setVisibility(View.VISIBLE);
                    webView.goBack();
                } else if (webView.canGoBack()) {
                    webView.goBack();
                } else {
                    finish();
                }
            }
        });
    }

    private void loadStartOrError() {
        if (!isNetworkAvailable()) {
            showInAppError(START_URL);
            return;
        }
        hasPageError = false;
        errorView.setVisibility(View.GONE);
        loadingView.setVisibility(View.VISIBLE);
        webView.loadUrl(START_URL);
    }

    private void retryLoad() {
        if (!isNetworkAvailable()) {
            showInAppError(lastFailedUrl);
            return;
        }
        hasPageError = false;
        errorView.setVisibility(View.GONE);
        loadingView.setVisibility(View.VISIBLE);
        webView.setVisibility(View.VISIBLE);
        String target = (lastFailedUrl != null && lastFailedUrl.startsWith("https://")) ? lastFailedUrl : START_URL;
        webView.loadUrl(target);
    }

    private void showInAppError(String url) {
        hasPageError = true;
        if (url != null && url.startsWith("https://")) {
            lastFailedUrl = url;
        }
        loadingView.setVisibility(View.GONE);
        webView.setVisibility(View.INVISIBLE);
        errorView.setVisibility(View.VISIBLE);
    }

    private void openExternalAction(Intent intent) {
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException ignored) {
        }
    }

    private boolean isNetworkAvailable() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return true;
        Network network = cm.getActiveNetwork();
        if (network == null) return false;
        NetworkCapabilities caps = cm.getNetworkCapabilities(network);
        return caps != null && (
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                || caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)
                || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
                || caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
        );
    }

    @Override
    protected void onSaveInstanceState(@NonNull Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onDestroy() {
        if (fileUploadCallback != null) {
            fileUploadCallback.onReceiveValue(null);
            fileUploadCallback = null;
        }
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}
