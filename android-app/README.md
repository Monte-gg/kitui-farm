# KITUI FARM Native Android App (`com.kituifarm.app`)

Standalone native Android WebView application for **KITUI FARM** (`https://monte-gg.github.io/kitui-farm/`).

- **Package Name:** `com.kituifarm.app`
- **App Name:** `KITUI FARM`
- **Version:** `1.0.0` (`versionCode: 1`)
- **Engine:** Native Android `WebView` (no Chrome Custom Tabs, no Trusted Web Activity, no PWA wrapper)
- **Permissions:** Strictly `INTERNET` and `ACCESS_NETWORK_STATE` only (no `POST_NOTIFICATIONS`, no microphone/media/location/contacts/SMS/storage)
- **Transport Security:** Strict HTTPS only (`usesCleartextTraffic="false"`, `MIXED_CONTENT_NEVER_ALLOW`)

## Build Signed Release APK Locally

### Prerequisites
- JDK 17
- Android SDK (Platform 34, Build-Tools 34.0.0)
- Gradle 8.9 (or Android Studio)

### Steps
1. Create a release keystore (one-time):
   ```bash
   keytool -genkeypair -v \
     -keystore kitui-farm-release.jks \
     -storetype PKCS12 \
     -keyalg RSA -keysize 2048 -validity 10000 \
     -alias kituifarm \
     -storepass YOUR_STORE_PASSWORD \
     -keypass YOUR_KEY_PASSWORD \
     -dname "CN=KITUI FARM, OU=Mobile, O=KITUI FARM, L=Kitui, C=KE"
   ```

2. Build the signed release APK:
   ```bash
   cd android-app
   KEYSTORE_PATH="$(pwd)/../kitui-farm-release.jks" \
   KEYSTORE_PASSWORD="YOUR_STORE_PASSWORD" \
   KEY_ALIAS="kituifarm" \
   KEY_PASSWORD="YOUR_KEY_PASSWORD" \
   gradle assembleRelease
   ```

3. Locate the signed APK:
   `android-app/app/build/outputs/apk/release/app-release.apk`

4. Verify the APK signature and permissions:
   ```bash
   apksigner verify --verbose android-app/app/build/outputs/apk/release/app-release.apk
   aapt2 dump badging android-app/app/build/outputs/apk/release/app-release.apk
   ```
