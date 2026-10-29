package dev.paperquay.mobile;

import org.junit.Test;

/** Runs the portable production store/policy regression suite in Gradle too. */
public final class IncomingSharePolicyJUnitTest {
    @Test public void portableStoreAndPolicyContract() throws Exception {
        IncomingShareStoreTest.main(new String[0]);
    }
}
