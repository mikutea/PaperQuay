package dev.paperquay.mobile;

import android.content.Context;
import android.content.pm.PackageManager;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

/** Run only in a separately built offline QA application, never a user profile. */
@RunWith(AndroidJUnit4.class)
public class BackgroundPrivacyFocusTest {
    private void requireOfflineQa() {
        Assume.assumeTrue("Requires the isolated offline QA build",
            "true".equals(InstrumentationRegistry.getArguments().getString("paperquayOfflineQa")));
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertTrue(context.getPackageName().endsWith(".backgroundprivacyqa"));
        assertEquals(PackageManager.PERMISSION_DENIED, context.checkSelfPermission("android.permission.INTERNET"));
    }

    private View cover(MainActivity activity) {
        return activity.getWindow().getDecorView().findViewWithTag("paperquay-privacy-cover");
    }

    @Test public void focusLossCoversAResumedActivityWithoutWaitingForPause() {
        requireOfflineQa();
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                activity.onWindowFocusChanged(true);
                assertNull(cover(activity));
                ViewGroup decor = (ViewGroup) activity.getWindow().getDecorView();
                int originalChildren = decor.getChildCount();
                for (int i = 0; i < 3; i++) {
                    activity.onWindowFocusChanged(false);
                    View hidden = cover(activity);
                    assertNotNull("Overview may leave the activity resumed", hidden);
                    activity.onWindowFocusChanged(false);
                    assertSame(hidden, cover(activity));
                    assertEquals(originalChildren + 1, decor.getChildCount());
                    activity.onWindowFocusChanged(true);
                    assertNull(cover(activity));
                    assertEquals(originalChildren, decor.getChildCount());
                }
                assertEquals("Foreground screenshots remain available", 0,
                    activity.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_SECURE);
            });
        }
    }

    @Test public void aLateFocusCallbackDoesNotUncoverAPausedActivity() {
        requireOfflineQa();
        AtomicReference<MainActivity> current = new AtomicReference<>();
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(current::set);
            scenario.moveToState(Lifecycle.State.STARTED);
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
                MainActivity activity = current.get();
                assertNotNull(cover(activity));
                activity.onWindowFocusChanged(true);
                assertNotNull("A focused callback must not override the paused state", cover(activity));
            });
            scenario.moveToState(Lifecycle.State.RESUMED);
            scenario.onActivity(activity -> {
                activity.onWindowFocusChanged(true);
                assertNull(cover(activity));
            });
        }
    }
}
