package com.kituifarm.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.provider.Settings;
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
import android.widget.Toast;
import android.graphics.Color;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends AppCompatActivity {

    private static final String START_URL = "https://monte-gg.github.io/kitui-farm/";
    private static final String APP_VERSION = "1.0.4";
    private static final String APP_UA_SUFFIX = " KituiFarmAndroidApp/" + APP_VERSION;
    private static final String CHANNEL_ID = "kitui_farm_alerts";
    private static final String PREFS_NAME = "kitui_farm_prefs";
    private static final String KEY_PERMS_PROMPTED = "perms_prompted_v1";
    private static final String EXTRA_TARGET_URL = "target_url";

    private WebView webView;
    private SwipeRefreshLayout swipeRefresh;
    private View loadingView;
    private View errorView;
    private boolean hasPageError = false;
    private boolean initialLoadDone = false;
    private String lastFailedUrl = START_URL;
    private ValueCallback<Uri[]> fileUploadCallback;
    private String pendingGeoOrigin;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private boolean pendingNativeLocationRequest = false;
    private LocationListener activeLocationListener = null;

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
                    pendingGeoCallback = null;
                    pendingGeoOrigin = null;
                }
                if (pendingNativeLocationRequest) {
                    pendingNativeLocationRequest = false;
                    if (granted) {
                        fetchNativeLocationAndDeliver();
                    } else {
                        deliverLocationError("Location permission was denied. Enable Location in App Settings or type your area manually.");
                    }
                }
                notifyPermissionsChanged();
            });

    private final ActivityResultLauncher<String[]> appPermissionsLauncher =
            registerForActivityResult(new ActivityResultContracts.RequestMultiplePermissions(), grants -> {
                boolean locGranted = Boolean.TRUE.equals(grants.get(Manifest.permission.ACCESS_FINE_LOCATION))
                        || Boolean.TRUE.equals(grants.get(Manifest.permission.ACCESS_COARSE_LOCATION));
                boolean notifGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                        || Boolean.TRUE.equals(grants.get(Manifest.permission.POST_NOTIFICATIONS));
                if (notifGranted) {
                    postNativeNotification(
                            "KITUI FARM alerts enabled",
                            "You will receive app notifications for messages, orders, wallet activity, and updates.",
                            START_URL + "notifications.html"
                    );
                }
                if (pendingGeoCallback != null && pendingGeoOrigin != null) {
                    pendingGeoCallback.invoke(pendingGeoOrigin, locGranted, false);
                    pendingGeoCallback = null;
                    pendingGeoOrigin = null;
                }
                if (pendingNativeLocationRequest && locGranted) {
                    pendingNativeLocationRequest = false;
                    fetchNativeLocationAndDeliver();
                }
                notifyPermissionsChanged();
            });

    private class NativeBridge {
        @JavascriptInterface
        public String getAppVersion() {
            return APP_VERSION;
        }

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

        @JavascriptInterface
        public void showNotification(String title, String body, String targetUrl) {
            runOnUiThread(() -> postNativeNotification(title, body, targetUrl));
        }

        @JavascriptInterface
        public void enableAllPermissions() {
            runOnUiThread(() -> {
                boolean hasLoc = hasLocationPermission();
                boolean hasNotif = hasNotificationPermission();
                if (hasLoc && hasNotif) {
                    Toast.makeText(MainActivity.this, "Location and Notifications are already enabled ✓", Toast.LENGTH_SHORT).show();
                    notifyPermissionsChanged();
                    return;
                }
                List<String> missing = getMissingPermissions();
                if (!missing.isEmpty()) {
                    boolean canShowRationale = false;
                    for (String perm : missing) {
                        if (ActivityCompat.shouldShowRequestPermissionRationale(MainActivity.this, perm)) {
                            canShowRationale = true;
                            break;
                        }
                    }
                    SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                    boolean prompted = prefs.getBoolean(KEY_PERMS_PROMPTED, false);
                    if (prompted && !canShowRationale) {
                        Toast.makeText(MainActivity.this, "Opening App Settings: please turn on Location & Notifications", Toast.LENGTH_LONG).show();
                        openAppSettings();
                        return;
                    }
                    prefs.edit().putBoolean(KEY_PERMS_PROMPTED, true).apply();
                    appPermissionsLauncher.launch(missing.toArray(new String[0]));
                } else {
                    notifyPermissionsChanged();
                }
            });
        }

        @JavascriptInterface
        public void requestAppPermissions() {
            enableAllPermissions();
        }

        @JavascriptInterface
        public void requestLocationPermission() {
            runOnUiThread(() -> {
                if (hasLocationPermission()) {
                    Toast.makeText(MainActivity.this, "Location access is already enabled ✓", Toast.LENGTH_SHORT).show();
                    notifyPermissionsChanged();
                    return;
                }
                boolean canShowRationale = ActivityCompat.shouldShowRequestPermissionRationale(MainActivity.this, Manifest.permission.ACCESS_FINE_LOCATION)
                        || ActivityCompat.shouldShowRequestPermissionRationale(MainActivity.this, Manifest.permission.ACCESS_COARSE_LOCATION);
                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                boolean prompted = prefs.getBoolean("kitui_loc_prompted", false);
                if (prompted && !canShowRationale) {
                    Toast.makeText(MainActivity.this, "Opening Settings: enable Location in Permissions", Toast.LENGTH_LONG).show();
                    openAppSettings();
                    return;
                }
                prefs.edit().putBoolean("kitui_loc_prompted", true).apply();
                locationPermissionLauncher.launch(new String[]{
                        Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION
                });
            });
        }

        @JavascriptInterface
        public void requestNotificationPermission() {
            runOnUiThread(() -> {
                if (hasNotificationPermission()) {
                    Toast.makeText(MainActivity.this, "Notifications are already enabled ✓", Toast.LENGTH_SHORT).show();
                    notifyPermissionsChanged();
                    return;
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    boolean canShowRationale = ActivityCompat.shouldShowRequestPermissionRationale(MainActivity.this, Manifest.permission.POST_NOTIFICATIONS);
                    SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                    boolean prompted = prefs.getBoolean("kitui_notif_prompted", false);
                    if (prompted && !canShowRationale) {
                        Toast.makeText(MainActivity.this, "Opening Settings: enable Notifications in Permissions", Toast.LENGTH_LONG).show();
                        openAppSettings();
                        return;
                    }
                    prefs.edit().putBoolean("kitui_notif_prompted", true).apply();
                    appPermissionsLauncher.launch(new String[]{ Manifest.permission.POST_NOTIFICATIONS });
                } else {
                    postNativeNotification(
                            "KITUI FARM alerts enabled",
                            "Notifications are active on your phone.",
                            START_URL + "notifications.html"
                    );
                    notifyPermissionsChanged();
                }
            });
        }

        @JavascriptInterface
        public boolean hasNotificationPermission() {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true;
            return ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.POST_NOTIFICATIONS)
                    == PackageManager.PERMISSION_GRANTED;
        }

        @JavascriptInterface
        public boolean hasLocationPermission() {
            return ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.ACCESS_FINE_LOCATION)
                    == PackageManager.PERMISSION_GRANTED
                    || ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.ACCESS_COARSE_LOCATION)
                    == PackageManager.PERMISSION_GRANTED;
        }

        @JavascriptInterface
        public void getCurrentLocation() {
            runOnUiThread(() -> {
                if (!hasLocationPermission()) {
                    pendingNativeLocationRequest = true;
                    locationPermissionLauncher.launch(new String[]{
                            Manifest.permission.ACCESS_FINE_LOCATION,
                            Manifest.permission.ACCESS_COARSE_LOCATION
                    });
                    return;
                }
                fetchNativeLocationAndDeliver();
            });
        }

        @JavascriptInterface
        public void openAppSettings() {
            runOnUiThread(() -> {
                Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                intent.setData(Uri.fromParts("package", getPackageName(), null));
                openExternalAction(intent);
            });
        }

        @JavascriptInterface
        public void copyText(String text) {
            runOnUiThread(() -> {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm != null && text != null) {
                    cm.setPrimaryClip(ClipData.newPlainText("KITUI FARM", text));
                }
            });
        }
    }

    @SuppressLint("MissingPermission")
    private void fetchNativeLocationAndDeliver() {
        LocationManager lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) {
            deliverLocationError("Location service is unavailable on this device.");
            return;
        }
        boolean gpsEnabled = false;
        boolean netEnabled = false;
        try { gpsEnabled = lm.isProviderEnabled(LocationManager.GPS_PROVIDER); } catch (Exception ignored) {}
        try { netEnabled = lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER); } catch (Exception ignored) {}

        // Try best recent last-known location first for instant response
        Location bestLast = null;
        String[] providers = new String[]{
                LocationManager.GPS_PROVIDER,
                LocationManager.NETWORK_PROVIDER,
                LocationManager.PASSIVE_PROVIDER
        };
        for (String p : providers) {
            try {
                Location loc = lm.getLastKnownLocation(p);
                if (loc != null && (bestLast == null || loc.getTime() > bestLast.getTime())) {
                    bestLast = loc;
                }
            } catch (Exception ignored) {}
        }
        if (bestLast != null && (System.currentTimeMillis() - bestLast.getTime()) < 10 * 60 * 1000L) {
            deliverLocationSuccess(bestLast.getLatitude(), bestLast.getLongitude());
            return;
        }

        if (!gpsEnabled && !netEnabled) {
            if (bestLast != null) {
                deliverLocationSuccess(bestLast.getLatitude(), bestLast.getLongitude());
            } else {
                deliverLocationError("Turn on Location (GPS) in your phone quick settings, then tap Use current location again.");
            }
            return;
        }

        final Location fallbackLast = bestLast;
        final boolean[] delivered = new boolean[]{ false };
        final Handler handler = new Handler(Looper.getMainLooper());

        LocationListener listener = new LocationListener() {
            @Override
            public void onLocationChanged(@NonNull Location location) {
                if (delivered[0]) return;
                delivered[0] = true;
                try { lm.removeUpdates(this); } catch (Exception ignored) {}
                activeLocationListener = null;
                deliverLocationSuccess(location.getLatitude(), location.getLongitude());
            }
        };
        activeLocationListener = listener;

        try {
            if (netEnabled) lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 0, 0, listener, Looper.getMainLooper());
            if (gpsEnabled) lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 0, 0, listener, Looper.getMainLooper());
        } catch (Exception e) {
            deliverLocationError("Could not start location lookup. Type your area manually.");
            return;
        }

        handler.postDelayed(() -> {
            if (delivered[0]) return;
            delivered[0] = true;
            try { lm.removeUpdates(listener); } catch (Exception ignored) {}
            activeLocationListener = null;
            if (fallbackLast != null) {
                deliverLocationSuccess(fallbackLast.getLatitude(), fallbackLast.getLongitude());
            } else {
                deliverLocationError("Location timed out. Make sure GPS is on and try again, or type your area manually.");
            }
        }, 12000);
    }

    private void deliverLocationSuccess(double lat, double lon) {
        if (webView == null) return;
        webView.evaluateJavascript(
                "if(window.__kituiNativeLocationCallback){window.__kituiNativeLocationCallback(" + lat + "," + lon + ",null);}",
                null
        );
    }

    private void deliverLocationError(String message) {
        if (webView == null) return;
        String safe = message.replace("\\", "\\\\").replace("'", "\\'");
        webView.evaluateJavascript(
                "if(window.__kituiNativeLocationCallback){window.__kituiNativeLocationCallback(null,null,'" + safe + "');}",
                null
        );
    }

    private void notifyPermissionsChanged() {
        if (webView == null) return;
        webView.evaluateJavascript(
                "if(window.__kituiPermissionsUpdated){window.__kituiPermissionsUpdated();}",
                null
        );
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webView);
        swipeRefresh = findViewById(R.id.swipeRefresh);
        loadingView = findViewById(R.id.loadingView);
        errorView = findViewById(R.id.errorView);
        Button tryAgainButton = findViewById(R.id.tryAgainButton);

        createNotificationChannel();
        configureSwipeRefresh();
        configureWebView();
        configureBackNavigation();

        tryAgainButton.setOnClickListener(v -> retryLoad());

        String deepLink = getIntent() != null ? getIntent().getStringExtra(EXTRA_TARGET_URL) : null;
        if (savedInstanceState != null && (deepLink == null || deepLink.isEmpty())) {
            webView.restoreState(savedInstanceState);
            initialLoadDone = true;
            loadingView.setVisibility(View.GONE);
        } else {
            String initialUrl = (deepLink != null && deepLink.startsWith("https://")) ? deepLink : START_URL;
            loadUrlOrError(initialUrl);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        notifyPermissionsChanged();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent != null) {
            String target = intent.getStringExtra(EXTRA_TARGET_URL);
            if (target != null && target.startsWith("https://") && webView != null) {
                loadUrlOrError(target);
            }
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "KITUI FARM Alerts",
                    NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("Messages, order updates, wallet activity, and app update notifications from KITUI FARM.");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    private void postNativeNotification(String title, String body, String targetUrl) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        String safeTitle = (title != null && !title.trim().isEmpty()) ? title.trim() : "KITUI FARM";
        String safeBody = body != null ? body.trim() : "";
        String safeUrl = (targetUrl != null && targetUrl.startsWith("https://")) ? targetUrl : START_URL + "notifications.html";

        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.putExtra(EXTRA_TARGET_URL, safeUrl);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        int notifId = (safeTitle + safeBody).hashCode();
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this,
                notifId,
                openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Bitmap largeIcon = BitmapFactory.decodeResource(getResources(), R.drawable.kitui_logo);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.kitui_logo)
                .setLargeIcon(largeIcon)
                .setContentTitle(safeTitle)
                .setContentText(safeBody)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(safeBody))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(pendingIntent);

        try {
            NotificationManagerCompat.from(this).notify(notifId, builder.build());
        } catch (SecurityException ignored) {
        }
    }

    private List<String> getMissingPermissions() {
        List<String> needed = new ArrayList<>();
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED
                && ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.ACCESS_FINE_LOCATION);
            needed.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        return needed;
    }

    private void launchMissingPermissions() {
        List<String> missing = getMissingPermissions();
        if (!missing.isEmpty()) {
            appPermissionsLauncher.launch(missing.toArray(new String[0]));
        } else {
            postNativeNotification(
                    "KITUI FARM permissions active",
                    "Location and app notifications are enabled on your phone.",
                    START_URL + "notifications.html"
            );
            notifyPermissionsChanged();
        }
    }

    private void maybeShowPermissionsPrompt() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        if (prefs.getBoolean(KEY_PERMS_PROMPTED, false)) return;
        List<String> missing = getMissingPermissions();
        if (missing.isEmpty()) {
            prefs.edit().putBoolean(KEY_PERMS_PROMPTED, true).apply();
            return;
        }
        prefs.edit().putBoolean(KEY_PERMS_PROMPTED, true).apply();

        new AlertDialog.Builder(this)
                .setTitle("Enable KITUI FARM permissions")
                .setMessage("Allow Location so 'Use current location' works on your profile and listings, and allow Notifications so you receive alerts for messages, orders, wallet activity, and app updates.")
                .setPositiveButton("Enable permissions", (dialog, which) -> launchMissingPermissions())
                .setNegativeButton("Not now", null)
                .show();
    }

    private void configureSwipeRefresh() {
        swipeRefresh.setColorSchemeResources(R.color.brand_green, R.color.brand_accent);
        swipeRefresh.setOnRefreshListener(() -> {
            if (webView != null) {
                webView.reload();
            } else {
                swipeRefresh.setRefreshing(false);
            }
        });
        swipeRefresh.setOnChildScrollUpCallback((parent, child) -> webView != null && webView.getScrollY() > 0);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        webView.setBackgroundColor(Color.parseColor("#171E19"));
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);

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
                    String path = uri.getPath() != null ? uri.getPath().toLowerCase() : "";
                    if (path.endsWith(".apk")) {
                        // Allow APK update downloads via system handler so the user can install updates
                        openExternalAction(new Intent(Intent.ACTION_VIEW, uri));
                        return true;
                    }
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
                swipeRefresh.setRefreshing(false);
                CookieManager.getInstance().flush();
                view.evaluateJavascript(
                        "(function(){try{" +
                        "if(window.KituiAndroid&&window.KituiAndroid.printPage){window.print=function(){window.KituiAndroid.printPage();};}" +
                        "var c=document.getElementById('kfAndroidApkCard');if(c)c.remove();" +
                        "document.documentElement.classList.add('kf-native-android-app');" +
                        "}catch(e){}})();",
                        null
                );
                if (!hasPageError) {
                    boolean wasFirstLoad = !initialLoadDone;
                    initialLoadDone = true;
                    loadingView.setVisibility(View.GONE);
                    errorView.setVisibility(View.GONE);
                    webView.setVisibility(View.VISIBLE);
                    if (wasFirstLoad) {
                        maybeShowPermissionsPrompt();
                    }
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request != null && request.isForMainFrame()) {
                    swipeRefresh.setRefreshing(false);
                    String failingUrl = request.getUrl() != null ? request.getUrl().toString() : START_URL;
                    showInAppError(failingUrl);
                }
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                swipeRefresh.setRefreshing(false);
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

    private void loadUrlOrError(String url) {
        if (!isNetworkAvailable()) {
            showInAppError(url);
            return;
        }
        hasPageError = false;
        errorView.setVisibility(View.GONE);
        loadingView.setVisibility(View.VISIBLE);
        webView.loadUrl(url);
    }

    private void retryLoad() {
        String target = (lastFailedUrl != null && lastFailedUrl.startsWith("https://")) ? lastFailedUrl : START_URL;
        if (!isNetworkAvailable()) {
            showInAppError(target);
            return;
        }
        hasPageError = false;
        errorView.setVisibility(View.GONE);
        loadingView.setVisibility(View.VISIBLE);
        webView.setVisibility(View.VISIBLE);
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
        if (activeLocationListener != null) {
            try {
                LocationManager lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
                if (lm != null) lm.removeUpdates(activeLocationListener);
            } catch (Exception ignored) {}
            activeLocationListener = null;
        }
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
