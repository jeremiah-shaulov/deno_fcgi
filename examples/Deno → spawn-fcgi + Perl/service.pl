#!/usr/bin/perl -wT

use strict;
use vars qw( $count );
use CGI::Fast;

local $count = 0;

while (my $q = new CGI::Fast)
{	$count++;
	print $q->header( "text/plain" ), "You are request number $count. Have a good day!\n";
}
