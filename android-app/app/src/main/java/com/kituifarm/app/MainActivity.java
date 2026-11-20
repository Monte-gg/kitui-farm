package com.kituifarm.app;

import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.view.View;
import android.webkit.CookieManager;
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

public class MainActivity extends AppCompatActivity {

    private static final String START_URL = "https://monte-gg.github.io/kitui-farm/";
    private static final String APP_UA_SUFFIX = " KituiFarmAndroidApp/1.0.0";

    private WebView webView;
    private View loadingView;
    private View errorView;
    private boolean hasPageError = false;
    private boolean initialLoadDone = false;
    private String lastFailedUrl = START_URL;
    private ValueCallback<Uri[]> fileUploadCallback;

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
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setSupportZoom(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setMediaPlaybackRequiresUserGesture(false);

        String defaultUa = settings.getUserAgentString();
        if (defaultUa != null && !defaultUa.contains("KituiFarmAndroidApp")) {
            settings.setUserAgentString(defaultUa + APP_UA_SUFFIX);
        }

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
                    // Never allow cleartext HTTP navigation; upgrade to HTTPS inside the app
                    Uri secureUri = uri.buildUpon().scheme("https").build();
                    view.loadUrl(secureUri.toString());
                    return true;
                }
                if ("https".equals(scheme)) {
                    // Keep all HTTPS navigation inside the native WebView (never open Chrome)
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
                // Keep HTTPS strictly secure: cancel insecure SSL and show in-app error
                handler.cancel();
                showInAppError(lastFailedUrl);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
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
            // Safely ignore if the device has no dialer or email client installed
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
